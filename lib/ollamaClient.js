"use strict";

const axios = require("axios");

class OllamaClient {
    /**
     * @param {string} serverUrlBase - Base URL of the Ollama server
     * @param {object} logger - Logger instance for logging
     */
    constructor(serverUrlBase, logger) {
        this._serverUrlBase = serverUrlBase;
        this._axios = axios;
        this.log = logger;
    }

    /**
     * Fetches available models from the Ollama server.
     * @returns {Promise<string[]>} - List of model names
     */
    async fetchModels() {
        try {
            const resp = await this._axios.get(`${this._serverUrlBase}/api/tags`, { timeout: 15000 });
            if (resp.status === 200) {
                if (Array.isArray(resp.data)) {
                    return resp.data;
                } else if (resp.data && Array.isArray(resp.data.tags)) {
                    return resp.data.tags;
                } else if (resp.data && Array.isArray(resp.data.models)) {
                    return resp.data.models.map(item => item.name || item.model);
                } else {
                    this.log.error(`Unexpected data structure from /api/tags: ${JSON.stringify(resp.data)}`);
                    throw new Error("Unexpected data structure");
                }
            } else {
                this.log.error(`Unexpected status from /api/tags: ${resp.status}`);
                throw new Error(`HTTP status ${resp.status}`);
            }
        } catch (err) {
            this.log.error(`Error fetching models from /api/tags: ${err}`);
            throw err;
        }
    }

    /**
     * Sends a chat payload to the Ollama server and retrieves the response.
     * @param {object} payload - Chat payload to send
     * @returns {Promise<object>} - Response from the server
     */
    async sendChatPayload(payload) {
        try {
            const resp = await this._axios.post(
                `${this._serverUrlBase}/api/chat`,
                payload,
                { headers: { "Content-Type": "application/json" }, timeout: 60000 }
            );
            return resp.data;
        } catch (err) {
            this.log.error(`Error sending chat payload: ${err}`);
            if (err.response && err.response.data) {
                this.log.error(`Response body: ${JSON.stringify(err.response.data)}`);
            }
            throw err;
        }
    }

    /**
     * Checks which models are currently running on the Ollama server.
     * @returns {Promise<object[]>} - List of running models with details
     */
    async checkRunningModels() {
        try {
            const resp = await this._axios.get(`${this._serverUrlBase}/api/ps`, { timeout: 15000 });
            if (Array.isArray(resp.data.models)) {
                return resp.data.models;
            } else if (Array.isArray(resp.data)) {
                return resp.data;
            } else if (Array.isArray(resp.data.processes)) {
                return resp.data.processes;
            } else {
                return [];
            }
        } catch (err) {
            this.log.error(`Error checking running models: ${err}`);
            throw err;
        }
    }

    /**
     * Builds a chat payload from the given states and sends it to the Ollama server.
     * @param {string} modelName - The name of the model.
     * @param {object} messageObj - The message object containing role and content.
     * @param {object} optionalStates - Optional states like tools, think, format, etc.
     * @returns {Promise<object>} - The response from the server.
     */
    async processChatMessage(modelName, messageObj, optionalStates) {
        const payload = { model: modelName, messages: [messageObj] };

        if (optionalStates.toolsState?.val && optionalStates.toolsState.val !== "[]") {
            try { payload.tools = JSON.parse(String(optionalStates.toolsState.val)); } catch (e) { this.log.error(`Invalid JSON in tools: ${e}`); }
        }
        if (optionalStates.thinkState) payload.think = !!optionalStates.thinkState.val;
        if (optionalStates.formatState?.val) {
            const formatVal = String(optionalStates.formatState.val);
            if (formatVal === "json") {
                payload.format = "json";
            } else if (formatVal && formatVal !== "{}") {
                try { payload.format = JSON.parse(formatVal); } catch (e) { this.log.error(`Invalid JSON in format: ${e}`); }
            }
        }
        if (optionalStates.optionsState?.val && optionalStates.optionsState.val !== "{}") {
            try { payload.options = JSON.parse(String(optionalStates.optionsState.val)); } catch (e) { this.log.error(`Invalid JSON in options: ${e}`); }
        }
        if (optionalStates.streamState) payload.stream = !!optionalStates.streamState.val;
        if (optionalStates.keepAliveState?.val) {
            payload.keep_alive = String(optionalStates.keepAliveState.val);
        }

        this.log.debug(`Chat payload: ${JSON.stringify(payload)}`);

        return await this.sendChatPayload(payload);
    }

    /**
     * Extracts the model ID from a state ID.
     * @param {string} stateId - The full state ID.
     * @returns {string} - The extracted model ID.
     */
    extractModelId(stateId) {
        const parts = stateId.split(".");
        return parts[parts.length - 3];
    }

    /**
     * Builds a message object from individual state datapoints.
     * @param {object} states - The states containing role, content, images, and tool calls.
     * @returns {object} - The constructed message object.
     */
    buildMessageObject(states) {
        const messageObj = {
            role: states.roleState?.val || "user",
            content: states.contentState?.val || ""
        };

        if (states.imagesState?.val && states.imagesState.val !== "[]") {
            try { messageObj.images = JSON.parse(String(states.imagesState.val)); } catch (e) { this.log.error(`Invalid JSON in images: ${e}`); }
        }
        if (states.toolCallsState?.val && states.toolCallsState.val !== "[]") {
            try { messageObj.tool_calls = JSON.parse(String(states.toolCallsState.val)); } catch (e) { this.log.error(`Invalid JSON in tool calls: ${e}`); }
        }

        return messageObj;
    }

    /**
     * Checks if the given state ID corresponds to a user message content input.
     * @param {string} namespace - The namespace of the adapter.
     * @param {string} stateId - The state ID to check.
     * @param {object} state - The state object to validate.
     * @returns {boolean} - True if the state ID matches the criteria, false otherwise.
     */
    isUserMessageInput(namespace, stateId, state) {
        return (
            stateId.startsWith(`${namespace}.models.`) &&
            stateId.endsWith(`.messages.content`) &&
            state?.val &&
            !state.ack
        );
    }

    /**
     * Handles user message content input.
     * @param {string} namespace - The namespace of the adapter.
     * @param {string} id - The state ID.
     * @param {object} state - The state object.
     * @param {Array} models - The list of models.
     * @param {function} getStateAsync - Function to retrieve state asynchronously.
     * @returns {Promise<{ modelId: string, answer: any, details: object } | null>} - Resolves with result or null if an error occurs.
     */
    async handleUserMessageInput(namespace, id, state, models, getStateAsync) {
        const modelId = this.extractModelId(id);
        if (!modelId) {
            this.log.error("Model ID could not be extracted from state ID.");
            return null;
        }

        const modelEntry = models.find(m => m.id === modelId);
        const modelName = modelEntry ? modelEntry.name : modelId;
        if (!modelName) {
            this.log.error("Model name could not be determined.");
            return null;
        }

        const states = {
            roleState: await getStateAsync(`models.${modelId}.messages.role`),
            contentState: await getStateAsync(`models.${modelId}.messages.content`),
            imagesState: await getStateAsync(`models.${modelId}.messages.images`),
            toolCallsState: await getStateAsync(`models.${modelId}.messages.tool_calls`),
        };

        const messageObj = this.buildMessageObject(states);
        if (!messageObj) {
            this.log.error("Failed to build message object.");
            return null;
        }

        const optionalStates = {
            toolsState: await getStateAsync(`models.${modelId}.tools`),
            thinkState: await getStateAsync(`models.${modelId}.think`),
            formatState: await getStateAsync(`models.${modelId}.format`),
            optionsState: await getStateAsync(`models.${modelId}.options`),
            streamState: await getStateAsync(`models.${modelId}.stream`),
            keepAliveState: await getStateAsync(`models.${modelId}.keep_alive`),
        };

        try {
            const resp = await this.processChatMessage(modelName, messageObj, optionalStates);
            let answer;
            if (resp && typeof resp === "object") {
                if (resp.response) {
                    answer = resp.response;
                } else if (resp.message && resp.message.content) {
                    answer = resp.message.content;
                } else {
                    answer = JSON.stringify(resp);
                }
            } else {
                answer = resp;
            }

            return { modelId, answer, details: {
                created_at: resp.created_at,
                role: resp.message?.role,
                content: resp.message?.content,
                total_duration: resp.total_duration,
                load_duration: resp.load_duration,
                prompt_eval_count: resp.prompt_eval_count,
                prompt_eval_duration: resp.prompt_eval_duration,
                eval_count: resp.eval_count,
                eval_duration: resp.eval_duration
            }};
        } catch (e) {
            this.log.error(`Error generating response for model ${modelId}: ${e}`);
            return null;
        }
    }
}

module.exports = OllamaClient;
