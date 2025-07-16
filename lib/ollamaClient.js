"use strict";

const axios = require("axios");
const QdrantHelper = require("./qdrantClient");
const DatapointController = require("./datapointController");

class OllamaClient {
    /**
     * @param {string} serverUrlBase
     * @param {object} logger
     * @param {ioBroker.Adapter} adapter
     */
    constructor(serverUrlBase, logger, adapter) {
        this._serverUrlBase = serverUrlBase;
        this._axios = axios;
        this.log = logger;
        this.adapter = adapter;
        this._monitorInterval = null;
        this._qdrantUrl = null;
        this._useVectorDb = false;
        this._datapointController = null;
        this._datapointControlEnabled = false;
        this._allowedDatapoints = new Set();
    }

    /**
     * Configure vector database settings
     * @param {boolean} useVectorDb
     * @param {string} qdrantUrl
     * @param {string} [embeddingModel='nomic-embed-text']
     * @param {number} [maxResults=20]
     * @throws {Error} Throws error if qdrantUrl is invalid when useVectorDb is true
     */
    configureVectorDb(useVectorDb, qdrantUrl, embeddingModel = 'nomic-embed-text', maxResults = 20) {
        try {
            if (useVectorDb && (!qdrantUrl || typeof qdrantUrl !== 'string')) {
                throw new Error('qdrantUrl must be a valid string when useVectorDb is enabled');
            }
            
            this._useVectorDb = useVectorDb;
            this._qdrantUrl = qdrantUrl;
            this._embeddingModel = embeddingModel;
            this._maxContextResults = maxResults;
            
            if (useVectorDb) {
                this.log.debug(`[VectorDB] Vector database configured for ALL models:`);
                this.log.debug(`[VectorDB] - Qdrant URL: ${qdrantUrl}`);
                this.log.debug(`[VectorDB] - Embedding Model: ${embeddingModel}`);
                this.log.debug(`[VectorDB] - Max Context Results: ${maxResults}`);
                this.log.debug(`[VectorDB] - All chat messages will be enhanced with context automatically`);
            } else {
                this.log.debug(`[VectorDB] Vector database is disabled`);
            }
        } catch (error) {
            this.log.error(`[VectorDB] Error configuring vector database: ${error.message}`);
            throw error;
        }
    }

    /**
     * Enhance user message with context from vector database
     */
    async enhanceMessageWithContext(userMessage) {
        if (!this._useVectorDb || !this._qdrantUrl) {
            return userMessage;
        }

        if (!userMessage || typeof userMessage !== 'string') {
            this.log.warn(`[VectorDB] Invalid user message provided for enhancement`);
            return userMessage || '';
        }

        try {
            const contextResults = await QdrantHelper.searchSimilar(
                userMessage,
                this._serverUrlBase,
                this._qdrantUrl,
                'iobroker_datapoints',
                this.log,
                this._maxContextResults,
                this._embeddingModel
            );

            if (contextResults.length === 0) {
                return userMessage;
            }

            // Build context from search results
            const contextText = contextResults
                .map(result => `${result.formatted_text} (Score: ${result.score.toFixed(3)}, Zeit: ${result.timestamp})`)
                .join('\n');

            // Check if this is a historical query requiring calculation
            const isHistoricalQuery = /(?:letzten?|vorherigen?|differenz|unterschied|zwischen|zwei)/i.test(userMessage);
            
            let enhancedMessage;
            if (isHistoricalQuery) {
                // For historical queries, provide structured context for calculation
                enhancedMessage = `Kontext aus ioBroker Datenpunkten (chronologisch sortiert):
${contextText}

Benutzer Anfrage: ${userMessage}

Hinweis: Die Datenpunkte sind chronologisch sortiert (neueste zuerst). Verwende die Werte und Zeitstempel für historische Berechnungen wie Differenzen oder Vergleiche.`;
            } else {
                // Standard context enhancement
                enhancedMessage = `Kontext aus ioBroker Datenpunkten:
${contextText}

Benutzer Anfrage: ${userMessage}

Bitte beantworte die Anfrage basierend auf dem bereitgestellten Kontext der ioBroker Datenpunkte.`;
            }

            this.log.debug(`[VectorDB] Enhanced message with ${contextResults.length} context results for query: "${userMessage}"`);
            this.log.debug(`[VectorDB] Context details: ${contextResults.map(r => `${r.datapoint_id}=${r.value} (${r.score.toFixed(3)})`).join(', ')}`);
            return enhancedMessage;

        } catch (error) {
            this.log.error(`[VectorDB] Error enhancing message with context: ${error.message}`);
            // Return original message on error to ensure chat functionality continues
            return userMessage;
        }
    }

    /**
     * Extracts the model ID from a state ID
     * Utility function to extract model identifier from ioBroker state paths.
     * @param {string} stateId
     * @throws {Error} Throws error if stateId is invalid
     */
    extractModelId(stateId) {
        if (!stateId || typeof stateId !== 'string') {
            throw new Error('stateId must be a valid string');
        }
        
        const parts = stateId.split(".");
        if (parts.length < 3) {
            throw new Error('Invalid stateId format');
        }
        
        return parts[parts.length - 3];
    }

    /**
     * Builds a message object from individual state datapoints.
     * @param {object} states
     * @returns {object}
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
     * Builds a chat payload from the given states and sends it to the Ollama server.
     * @param {string} modelName
     * @param {object} messageObj
     * @param {object} optionalStates
     * @returns {Promise<object>}
     */
    async processChatMessage(modelName, messageObj, optionalStates) {
        // Enhance message with vector database context if enabled
        if (this._useVectorDb && messageObj.role === 'user' && messageObj.content) {
            this.log.debug(`[VectorDB] Processing message for model ${modelName} with vector database context`);
            messageObj.content = await this.enhanceMessageWithContext(messageObj.content);
        }

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
     * Sends a chat payload to the Ollama server and retrieves the response.
     * @param {object} payload
     * @returns {Promise<object>}
     */
    async sendChatPayload(payload) {
        // indicate monitor tick
        this.log.debug('Checking running models on server...');
        try {
            // Mark connection alive on successful tick
            if (this.adapter && typeof this.adapter.setState === 'function') {
                this.adapter.setState('info.connection', true, true).catch(e => this.log.error(`Error setting connection state: ${e}`));
            }
            const resp = await this._axios.post(
                `${this._serverUrlBase}/api/chat`,
                payload,
                // Allow longer timeout (up to 5 minutes) for image analysis
                { headers: { "Content-Type": "application/json" }, timeout: 300000 }
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
     * @returns {Promise<object[]>}
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
            // mark adapter as disconnected if available
            if (this.adapter && typeof this.adapter.setState === 'function') {
                this.adapter.setState('info.connection', false, true).catch(e => this.log.error(`Error setting connection state: ${e}`));
            }
            // swallow error to continue monitoring
            return [];
        }
   }

    /**
     * Fetches the list of available models from the Ollama server.
     * @returns {Promise<string[]>}
     */
    async fetchModels() {
        try {
            const resp = await this._axios.get(`${this._serverUrlBase}/api/tags`, { timeout: 15000 });
            const data = resp.data;
            if (Array.isArray(data)) {
                // direct array of model names or objects
                return data.map(item => (typeof item === 'string' ? item : item.name || item.model));
            } else if (data && Array.isArray(data.models)) {
                // wrapped in { models: [...] }
                return data.models.map(item => item.name || item.model);
            } else if (data && Array.isArray(data.tags)) {
                // wrapped in { tags: [...] }
                return data.tags;
            } else {
                this.log.error(`Unexpected response structure when fetching models: ${JSON.stringify(data)}`);
                return [];
            }
        } catch (err) {
            this.log.error(`Error fetching models: ${err}`);
            throw err;
        }
    }

    /**
     * Handles user message content input.
     * @param {string} namespace
     * @param {string} id
     * @param {object} state
     * @param {Array} models
     * @param {function} getStateAsync
     * @returns {Promise<{ modelId: string, answer: any, details: object } | null>} Result or null if an error occurs
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

            // Process response for datapoint changes
            if (answer && typeof answer === 'string') {
                try {
                    const executedActions = await this.processResponseForDatapointChanges(answer, modelId);
                    if (executedActions.length > 0) {
                        this.log.info(`[DatapointControl] Model ${modelId} response triggered ${executedActions.length} datapoint changes`);
                    }
                } catch (error) {
                    this.log.error(`[DatapointControl] Error processing response for datapoint changes: ${error.message}`);
                }
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

    /**
     * Process AI response and execute datapoint changes if function calls are detected
     * @param {string} response
     * @param {string} modelId
     * @returns {Promise<Array>}
     */
    async processResponseForDatapointChanges(response, modelId) {
        if (!this._datapointControlEnabled || !this._datapointController || !response || typeof response !== 'string') {
            return [];
        }

        try {
            // For now, just return empty array as function calling is handled via chatWithFunctionCalling
            return [];
        } catch (error) {
            this.log.error(`[DatapointControl] Error processing response for datapoint changes: ${error.message}`);
            return [];
        }
    }

    /**
     * Configure datapoint control settings
     * @param {boolean} enabled
     * @param {Set} allowedDatapoints
     */
    configureDatapointControl(enabled, allowedDatapoints = new Set()) {
        this._datapointControlEnabled = enabled;
        this._allowedDatapoints = allowedDatapoints;
        
        if (enabled) {
            if (!this._datapointController) {
                this._datapointController = new DatapointController(this.adapter, this.log);
            }
            // Update allowed datapoints
            this._datapointController.setAllowedDatapoints(allowedDatapoints);
            this.log.debug(`[DatapointControl] Datapoint control enabled for ${allowedDatapoints.size} datapoints`);
        } else {
            this.log.debug(`[DatapointControl] Datapoint control is disabled`);
        }
    }

    /**
     * Update allowed datapoints for automatic changes
     * @param {Set} allowedDatapoints
     */
    updateAllowedDatapoints(allowedDatapoints) {
        this._allowedDatapoints = allowedDatapoints;
        if (this._datapointController) {
            this._datapointController.setAllowedDatapoints(allowedDatapoints);
        }
    }

    /**
     * Starts periodic checks for running models.
     * @param {Array} models
     * @param {string} namespace
     * @param {number} intervalMs
     */
    startMonitor(models, namespace, intervalMs) {
        // start monitoring running models
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
        }
        // initial check
        this._runMonitor(models, namespace);
        if (intervalMs > 0) {
            this._monitorInterval = setInterval(() => this._runMonitor(models, namespace), intervalMs);
        }
    }

    /**
     * Stops the periodic running-model monitoring.
     */
    stopMonitor() {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
            this.log.debug(`Stopped model-running monitor`);
        }
    }

    async _runMonitor(models, namespace) {
        // fetch running models from server
        const runningProcesses = await this.checkRunningModels();
        // list of configured model names that are currently running
        const runningNames = models
            .filter(m => runningProcesses.some(p => p.name === m.name || p.model === m.name || p.model === m.id))
            .map(m => m.name);
        // always log summary of running models
        this.log.debug(`Running Models: ${runningNames.length ? runningNames.join(', ') : 'none'}`);
        // update running state for each model
        for (const model of models) {
            const isRunning = runningNames.includes(model.name);
            const psEntry = runningProcesses.find(item => item.name === model.name || item.model === model.name || item.model === model.id);
            const expiresVal = psEntry?.expires_at || "";
            
            await this.adapter.setState(`models.${model.id}.running`, isRunning, true);
            await this.adapter.setState(`models.${model.id}.expires`, expiresVal, true);
        }
    }
}

module.exports = OllamaClient;
