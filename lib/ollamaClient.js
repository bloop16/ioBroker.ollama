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
                .map(result => {
                    const text = result.formatted_text || `${result.datapoint_id}=${result.value}`;
                    return `${text} (Score: ${result.score.toFixed(3)}, Zeit: ${result.timestamp})`;
                })
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

        // Automatically inject datapoint control tools if enabled
        if (this._datapointControlEnabled && this._datapointController) {
            const datapointTools = this._datapointController.getFunctionDefinitions();
            this.log.debug(`[DatapointControl] Attempting to inject ${datapointTools.length} datapoint control tools`);
            
            payload.tools = datapointTools;
            
            // Merge with manual tools if specified
            if (optionalStates.toolsState?.val && optionalStates.toolsState.val !== "[]") {
                try { 
                    const manualTools = JSON.parse(String(optionalStates.toolsState.val));
                    if (Array.isArray(manualTools)) {
                        payload.tools = [...payload.tools, ...manualTools];
                    } else {
                        this.log.warn(`[DatapointControl] Manual tools is not an array, ignoring`);
                    }
                } catch (e) { 
                    this.log.error(`[DatapointControl] Invalid JSON in tools: ${e.message}`); 
                }
            }
            
            this.log.debug(`[DatapointControl] Final tools count: ${payload.tools.length}`);
        } else {
            // Only add manual tools if datapoint control is disabled
            if (optionalStates.toolsState?.val && optionalStates.toolsState.val !== "[]") {
                try { 
                    const manualTools = JSON.parse(String(optionalStates.toolsState.val));
                    if (Array.isArray(manualTools)) {
                        payload.tools = manualTools;
                    }
                } catch (e) { 
                    this.log.error(`[DatapointControl] Invalid JSON in tools: ${e.message}`); 
                }
            }
        }

        // Add optional parameters only if they have meaningful values
        if (optionalStates.thinkState?.val === true) {
            payload.think = true;
        }
        
        if (optionalStates.formatState?.val) {
            const formatVal = String(optionalStates.formatState.val);
            if (formatVal === "json") {
                payload.format = "json";
            } else if (formatVal && formatVal !== "{}") {
                try { 
                    payload.format = JSON.parse(formatVal); 
                } catch (e) { 
                    this.log.error(`[DatapointControl] Invalid JSON in format: ${e.message}`); 
                }
            }
        }
        
        if (optionalStates.optionsState?.val && optionalStates.optionsState.val !== "{}") {
            try { 
                payload.options = JSON.parse(String(optionalStates.optionsState.val)); 
            } catch (e) { 
                this.log.error(`[DatapointControl] Invalid JSON in options: ${e.message}`); 
            }
        }
        
        if (optionalStates.streamState?.val === true) {
            payload.stream = true;
        }
        
        if (optionalStates.keepAliveState?.val) {
            payload.keep_alive = String(optionalStates.keepAliveState.val);
        }

        this.log.debug(`[DatapointControl] Chat payload prepared for model ${modelName}`);
        this.log.debug(`[DatapointControl] Payload size: ${JSON.stringify(payload).length} chars`);

        return await this.sendChatPayloadWithFallback(payload);
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
     * Sends a chat payload with fallback for unsupported tool calls
     * @param {object} payload
     * @returns {Promise<object>}
     */
    async sendChatPayloadWithFallback(payload) {
        try {
            // First try with tools if they exist
            return await this.sendChatPayload(payload);
        } catch (error) {
            // Check if error is related to tool support
            if (error.response && error.response.status === 400 && 
                error.response.data && error.response.data.error && 
                error.response.data.error.includes('does not support tools')) {
                
                this.log.warn(`[DatapointControl] Model ${payload.model} does not support function calling. Falling back to text-based processing.`);
                
                // Remove tools and retry
                const fallbackPayload = { ...payload };
                delete fallbackPayload.tools;
                
                const response = await this.sendChatPayload(fallbackPayload);
                
                // Handle both object and string responses (streaming responses are concatenated strings)
                if (typeof response === 'object' && response !== null) {
                    // Normal object response
                    response._fallbackMode = true;
                    return response;
                } else if (typeof response === 'string') {
                    // Streaming response - parse the final message
                    try {
                        // Split by newlines and get the last complete JSON object
                        const lines = response.trim().split('\n');
                        const lastLine = lines[lines.length - 1];
                        const parsedResponse = JSON.parse(lastLine);
                        parsedResponse._fallbackMode = true;
                        return parsedResponse;
                    } catch (parseError) {
                        this.log.error(`[DatapointControl] Error parsing streaming response: ${parseError.message}`);
                        // Return a minimal response object
                        return {
                            message: { role: 'assistant', content: response },
                            _fallbackMode: true
                        };
                    }
                } else {
                    // Unexpected response type
                    return {
                        message: { role: 'assistant', content: String(response) },
                        _fallbackMode: true
                    };
                }
            } else {
                // Re-throw other errors
                throw error;
            }
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
            let toolCallResults = [];
            
            if (resp && typeof resp === "object") {
                if (resp.response) {
                    answer = resp.response;
                } else if (resp.message && resp.message.content) {
                    answer = resp.message.content;
                } else {
                    answer = JSON.stringify(resp);
                }
                
                // Debug output for AI response
                this.log.info(`[AI Response] Model: ${modelId}, Content: ${answer ? answer.substring(0, 200) + (answer.length > 200 ? '...' : '') : 'No content'}`);
                
                // Process tool calls if present
                if (resp.message && resp.message.tool_calls && Array.isArray(resp.message.tool_calls)) {
                    this.log.info(`[DatapointControl] Model ${modelId} made ${resp.message.tool_calls.length} tool calls`);
                    toolCallResults = await this.processToolCalls(resp.message.tool_calls, modelId);
                }
            } else {
                answer = resp;
                // Debug output for simple response
                this.log.info(`[AI Response] Model: ${modelId}, Simple response: ${answer ? answer.substring(0, 200) + (answer.length > 200 ? '...' : '') : 'No content'}`);
            }

            // Process response for datapoint changes (legacy text-based approach)
            // For fallback mode, also check the original user message for commands
            if (answer && typeof answer === 'string') {
                try {
                    // First, check the AI response for any commands
                    let executedActions = await this.processResponseForDatapointChanges(answer, modelId);
                    
                    if (executedActions.length > 0) {
                        this.log.info(`[Text Parser] Found ${executedActions.length} commands in AI response`);
                    }
                    
                    // If no actions found in response and we're in fallback mode, check original user message
                    if (executedActions.length === 0 && resp._fallbackMode && messageObj.content) {
                        this.log.info(`[Text Parser] No commands found in AI response, checking original user message for fallback mode`);
                        executedActions = await this.processResponseForDatapointChanges(messageObj.content, modelId);
                        
                        if (executedActions.length > 0) {
                            this.log.info(`[Text Parser] Found ${executedActions.length} commands in original user message`);
                        }
                    }
                    
                    if (executedActions.length > 0) {
                        this.log.info(`[DatapointControl] Model ${modelId} triggered ${executedActions.length} datapoint changes`);
                        toolCallResults = [...toolCallResults, ...executedActions];
                    }
                } catch (error) {
                    this.log.error(`[DatapointControl] Error processing response for datapoint changes: ${error.message}`);
                }
            }

            return { 
                modelId, 
                answer, 
                details: {
                    created_at: resp.created_at,
                    role: resp.message?.role,
                    content: resp.message?.content,
                    total_duration: resp.total_duration,
                    load_duration: resp.load_duration,
                    prompt_eval_count: resp.prompt_eval_count,
                    prompt_eval_duration: resp.prompt_eval_duration,
                    eval_count: resp.eval_count,
                    eval_duration: resp.eval_duration,
                    tool_call_results: toolCallResults
                }
            };
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
            // Text-based parsing for models that don't support function calling
            this.log.debug(`[DatapointControl] Processing response for text-based datapoint changes: "${response}"`);
            
            const results = [];
            
            // Pattern for setting datapoint values: "setze|setzt|set" + datapoint + "auf|to" + value
            const setPatterns = [
                // Pattern for "setze/setzt/set" commands with proper datapoint format
                /(?:setze|setzt|set)\s+((?:\d+_)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s+(?:auf|to)\s+([^\s\.,;]+)/gi,
                // Pattern for direct assignment with proper datapoint format: datapoint = value
                /((?:\d+_)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*=\s*([^\s\.,;=]+)/gi,
                // Pattern for "turn on/off" with proper datapoint format
                /(?:schalte|turn)\s+((?:\d+_)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s+(?:ein|an|on)/gi,
                /(?:schalte|turn)\s+((?:\d+_)?[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s+(?:aus|off)/gi
            ];
            
            for (const pattern of setPatterns) {
                let match;
                while ((match = pattern.exec(response)) !== null) {
                    const datapointId = match[1];
                    let value = match[2];
                    
                    // Validate datapoint ID format (must contain at least one dot and be reasonable length)
                    if (!datapointId || datapointId.length < 3 || !datapointId.includes('.') || datapointId.length > 100) {
                        this.log.debug(`[DatapointControl] Skipping invalid datapoint ID: "${datapointId}"`);
                        continue;
                    }
                    
                    // Skip single character or very short matches that are likely false positives
                    if (datapointId.length < 5) {
                        this.log.debug(`[DatapointControl] Skipping too short datapoint ID: "${datapointId}"`);
                        continue;
                    }
                    
                    // Handle special cases for on/off patterns
                    if (pattern.source.includes('ein|an|on')) {
                        value = 'true';
                    } else if (pattern.source.includes('aus|off')) {
                        value = 'false';
                    }
                    
                    // Clean up the value
                    value = value.replace(/['"]/g, ''); // Remove quotes
                    
                    // Convert common German/English boolean values
                    let convertedValue;
                    if (/^(true|wahr|ein|an|on|yes|ja)$/i.test(value)) {
                        convertedValue = true;
                    } else if (/^(false|falsch|aus|off|no|nein)$/i.test(value)) {
                        convertedValue = false;
                    } else if (/^\d+(\.\d+)?$/.test(value)) {
                        // Convert numeric values
                        convertedValue = parseFloat(value);
                    } else {
                        convertedValue = value;
                    }
                    
                    this.log.info(`[DatapointControl] Text-based parsing detected: ${datapointId} = ${convertedValue}`);
                    
                    try {
                        // First check if datapoint exists before attempting to set it
                        const obj = await this.adapter.getForeignObjectAsync(datapointId);
                        if (!obj) {
                            this.log.debug(`[DatapointControl] Skipping non-existent datapoint: ${datapointId}`);
                            continue;
                        }
                        
                        // Execute the function call using the DatapointController
                        const result = await this._datapointController.executeFunctionCall(
                            'setDatapointValue',
                            { datapointId, value: convertedValue },
                            modelId
                        );
                        
                        results.push(result);
                        
                        if (result.success) {
                            this.log.info(`[DatapointControl] Successfully set ${datapointId} to ${convertedValue} via text parsing`);
                        } else {
                            this.log.warn(`[DatapointControl] Failed to set ${datapointId}: ${result.error}`);
                        }
                        
                    } catch (error) {
                        this.log.error(`[DatapointControl] Error executing text-based command for ${datapointId}: ${error.message}`);
                        results.push({
                            success: false,
                            datapointId,
                            error: error.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
            
            return results;
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

    /**
     * Process tool calls from AI response
     * @param {Array} toolCalls
     * @param {string} modelId
     * @returns {Promise<Array>}
     */
    async processToolCalls(toolCalls, modelId) {
        if (!this._datapointControlEnabled || !this._datapointController) {
            this.log.warn(`[DatapointControl] Tool calls received but datapoint control is not enabled`);
            return [];
        }

        const results = [];
        
        for (const toolCall of toolCalls) {
            try {
                if (toolCall.function && toolCall.function.name) {
                    const functionName = toolCall.function.name;
                    // Handle arguments - they might be a string or already parsed object
                    let parameters = {};
                    if (toolCall.function.arguments) {
                        if (typeof toolCall.function.arguments === 'string') {
                            parameters = JSON.parse(toolCall.function.arguments);
                        } else {
                            parameters = toolCall.function.arguments;
                        }
                    }
                    
                    this.log.info(`[DatapointControl] Executing tool call: ${functionName} with parameters: ${JSON.stringify(parameters)}`);
                    
                    const result = await this._datapointController.executeFunctionCall(functionName, parameters, modelId);
                    results.push(result);
                    
                    if (result.success) {
                        this.log.info(`[DatapointControl] Tool call ${functionName} executed successfully`);
                    } else {
                        this.log.error(`[DatapointControl] Tool call ${functionName} failed: ${result.error}`);
                    }
                } else {
                    this.log.error(`[DatapointControl] Invalid tool call format: ${JSON.stringify(toolCall)}`);
                }
            } catch (error) {
                this.log.error(`[DatapointControl] Error processing tool call: ${error.message}`);
                results.push({
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        return results;
    }
}

module.exports = OllamaClient;
