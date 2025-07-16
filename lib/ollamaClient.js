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
     */
    configureVectorDb(useVectorDb, qdrantUrl, embeddingModel = 'nomic-embed-text', maxResults = 20) {
        this._useVectorDb = useVectorDb;
        this._qdrantUrl = qdrantUrl;
        this._embeddingModel = embeddingModel;
        this._maxContextResults = maxResults;
        
        if (useVectorDb) {
            this.log.info(`[VectorDB] Vector database configured: ${qdrantUrl}`);
        }
    }

    /**
     * Get system message for datapoint control
     * @deprecated This method is no longer used - the model has built-in instructions
     */
    getSystemMessageForDatapointControl() {
        return `Du bist ein ioBroker-Assistent für die Hausautomation. Du kannst Smart-Home-Geräte steuern.

Bei Anfragen zur Steuerung von Geräten, antworte mit:
1. Einer natürlichen Antwort für den Benutzer
2. JSON-Aktionen am Ende der Antwort (falls erforderlich)

Für Gerätsteuerung verwende diese JSON-Struktur:
{
  "actions": [
    {
      "type": "setDatapointValue",
      "datapointId": "datapoint_id_here",
      "value": "value_here"
    },
    {
      "type": "getDatapointValue", 
      "datapointId": "datapoint_id_here"
    }
  ]
}

Verfügbare Datenpunkt-IDs:
${Array.from(this._allowedDatapoints).slice(0, 10).join(', ')}${this._allowedDatapoints.size > 10 ? '...' : ''}

Antworte immer hilfsbereit und natürlich.`;
    }

    /**
     * Get context data from vector database
     */
    async getVectorDbContext(userMessage) {
        if (!this._useVectorDb || !this._qdrantUrl || !userMessage) {
            return [];
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
                return [];
            }

            // Debug: Log the raw context results
            this.log.debug(`[VectorDB] Raw context results: ${JSON.stringify(contextResults, null, 2)}`);

            // Group by datapoint_id and keep only the most recent entry for each
            const latestByDatapoint = new Map();
            
            for (const result of contextResults) {
                const datapointId = result.datapoint_id;
                const timestamp = new Date(result.timestamp).getTime();
                
                if (!latestByDatapoint.has(datapointId)) {
                    latestByDatapoint.set(datapointId, result);
                } else {
                    const existing = latestByDatapoint.get(datapointId);
                    const existingTimestamp = new Date(existing.timestamp).getTime();
                    
                    // Keep the entry with the newer timestamp
                    if (timestamp > existingTimestamp) {
                        latestByDatapoint.set(datapointId, result);
                    }
                }
            }

            // Format the results using only the latest entry for each datapoint
            const formattedResults = Array.from(latestByDatapoint.values())
                .map(result => {
                    let formattedText = result.formatted_text;
                    
                    // If formatted_text is not available, create it from the data
                    if (!formattedText || formattedText.trim() === '') {
                        formattedText = `${result.datapoint_id}: ${result.value}`;
                    }
                    
                    // Add timestamp info for debugging
                    const timestamp = new Date(result.timestamp).toLocaleString('de-DE');
                    this.log.debug(`[VectorDB] Using latest entry for ${result.datapoint_id}: ${formattedText} (${timestamp})`);
                    
                    return formattedText.trim();
                })
                .filter(text => text && text !== '')
                .slice(0, 10); // Limit to 10 entries

            this.log.debug(`[VectorDB] Formatted context results: ${JSON.stringify(formattedResults)}`);
            
            return formattedResults;
        } catch (error) {
            this.log.error(`[VectorDB] Error getting context: ${error.message}`);
            return [];
        }
    }

    /**
     * Enhance user message to request structured JSON output for datapoint control
     */
    /**
     * Enhance user message to request structured JSON output for datapoint control
     * @deprecated This method is no longer used with the new multi-message approach
     */
    enhanceMessageForStructuredOutput(userMessage) {
        const instruction = `
You are an ioBroker assistant that can control smart home devices. 

User request: "${userMessage}"

Please respond with BOTH:
1. A natural language response to the user
2. Actions in JSON format (if any datapoint actions are needed)

For datapoint actions, use this JSON structure:
{
  "actions": [
    {
      "type": "setDatapointValue",
      "datapointId": "datapoint_id_here",
      "value": "value_here"
    },
    {
      "type": "getDatapointValue", 
      "datapointId": "datapoint_id_here"
    }
  ]
}

Available datapoint IDs that can be controlled:
${Array.from(this._allowedDatapoints).slice(0, 10).join(', ')}${this._allowedDatapoints.size > 10 ? '...' : ''}

Always respond in a helpful, natural way AND include the JSON actions at the end of your response if needed.
`;
        
        return instruction;
    }

    /**
     * Enhance user message with context from vector database
     * @deprecated This method is no longer used with the new multi-message approach
     */
    async enhanceMessageWithContext(userMessage) {
        if (!this._useVectorDb || !this._qdrantUrl || !userMessage) {
            return userMessage;
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
                .map(result => `${result.formatted_text || result.datapoint_id}=${result.value}`)
                .slice(0, 10) // Limit context to avoid token overflow
                .join('\n');

            return `Context:\n${contextText}\n\nUser Query: ${userMessage}`;
        } catch (error) {
            this.log.error(`[VectorDB] Error enhancing message: ${error.message}`);
            return userMessage;
        }
    }

    /**
     * Process chat message with structured JSON output (no tools needed)
     */
    async processChatMessage(modelName, messageObj, options = {}) {
        // Validate inputs
        if (!modelName || !messageObj || !messageObj.content) {
            this.log.error(`[API] Invalid inputs: modelName="${modelName}", messageObj=${JSON.stringify(messageObj)}`);
            return null;
        }
        
        this.log.debug(`[API] Processing chat message for model: "${modelName}"`);

        // Build messages array - only add context if needed, no system prompt override
        const messages = [];

        // Add context from vector database as separate message if enabled
        if (this._useVectorDb && messageObj.role === 'user' && messageObj.content) {
            const contextData = await this.getVectorDbContext(messageObj.content);
            if (contextData && contextData.length > 0) {
                messages.push({
                    role: "assistant",
                    content: `Aktuelle Gerätedaten:\n${contextData.join('\n')}`
                });
            }
        }

        // Add the original user message unchanged
        messages.push(messageObj);

        // Debug: Log the message structure
        this.log.debug(`[API] Message structure: ${messages.length} messages`);
        messages.forEach((msg, index) => {
            this.log.debug(`[API] Message ${index}: ${msg.role} - ${msg.content.substring(0, 100)}...`);
        });

        const payload = { model: modelName, messages: messages };

        // Add optional parameters
        if (options.think === true) payload.think = true;
        if (options.format) payload.format = options.format;
        if (options.options && options.options !== "{}") {
            try {
                payload.options = JSON.parse(String(options.options));
            } catch (e) {
                this.log.warn(`Invalid options JSON: ${options.options}`);
            }
        }
        // Force streaming to false - this is critical for proper adapter functionality
        payload.stream = false;
        if (options.keepAlive) payload.keep_alive = String(options.keepAlive);

        try {
            const resp = await this.sendChatPayload(payload);
            return await this.processResponse(resp, modelName);
        } catch (error) {
            this.log.error(`Error processing chat message: ${error.message}`);
            return null;
        }
    }

    /**
     * Send chat payload to Ollama server
     */
    async sendChatPayload(payload) {
        try {
            // Force streaming to false explicitly - this is critical for adapter functionality
            payload.stream = false;
            
            // Remove any stream parameter that might have been set elsewhere
            if (payload.hasOwnProperty('stream')) {
                payload.stream = false;
            }
            
            // Debug: Log the payload being sent
            this.log.debug(`[API] Sending payload to ${this._serverUrlBase}/api/chat: ${JSON.stringify(payload, null, 2)}`);
            
            const resp = await this._axios.post(
                `${this._serverUrlBase}/api/chat`,
                payload,
                { headers: { "Content-Type": "application/json" }, timeout: 300000 }
            );
            
            // Check if we got a streaming response despite setting stream=false
            if (resp.data && typeof resp.data === 'string') {
                this.log.warn(`[API] Received streaming response despite stream=false, attempting to parse`);
                
                // Try to parse and reconstruct the complete message from stream
                const lines = resp.data.split('\n').filter(line => line.trim());
                let completeContent = '';
                let lastCompleteResponse = null;
                
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.message && parsed.message.content) {
                            completeContent += parsed.message.content;
                        }
                        if (parsed.done === true) {
                            lastCompleteResponse = parsed;
                            break;
                        }
                    } catch (e) {
                        // Ignore parsing errors for incomplete lines
                    }
                }
                
                if (lastCompleteResponse) {
                    // Create a complete response with the reconstructed content
                    const completeResponse = {
                        ...lastCompleteResponse,
                        message: {
                            ...lastCompleteResponse.message,
                            content: completeContent
                        }
                    };
                    
                    this.log.debug(`[API] Successfully reconstructed streaming response: ${completeContent.substring(0, 100)}...`);
                    return completeResponse;
                } else {
                    this.log.error(`[API] Could not parse streaming response`);
                    return { message: { content: resp.data } };
                }
            }
            
            return resp.data;
        } catch (error) {
            this.log.error(`Error sending chat payload: ${error.message}`);
            if (error.response) {
                this.log.error(`Response status: ${error.response.status}`);
                this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    /**
     * Process response from Ollama (extract JSON actions and execute them)
     */
    async processResponse(resp, modelName) {
        let answer;
        let actionResults = [];
        
        // Extract answer from response
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

        // Log the complete response for debugging
        this.log.debug(`[API] Complete response from ${modelName}: ${JSON.stringify(resp, null, 2)}`);
        
        // Log response content
        if (answer) {
            this.log.info(`[AI] ${modelName} response: ${answer.substring(0, 200)}${answer.length > 200 ? '...' : ''}`);
        } else {
            this.log.warn(`[AI] ${modelName}: No response content received`);
        }
        
        // Extract and execute JSON actions from the response
        if (answer && typeof answer === 'string' && this._datapointControlEnabled) {
            actionResults = await this.extractAndExecuteJsonActions(answer, modelName);
        }

        return { 
            answer, 
            toolCallResults: actionResults, // Keep the same property name for compatibility
            modelId: modelName.replace(/[^a-zA-Z0-9_]/g, "_")
        };
    }

    /**
     * Extract JSON actions from response and execute them
     */
    async extractAndExecuteJsonActions(responseText, modelId) {
        if (!this._datapointControlEnabled || !this._datapointController) {
            this.log.debug(`[JSON] Datapoint control not enabled or controller not initialized`);
            return [];
        }

        const results = [];
        
        try {
            // Look for JSON blocks in the response using multiple patterns
            const jsonPatterns = [
                /\{[\s\S]*?"actions"[\s\S]*?\}/g,  // Original pattern
                /```json\s*(\{[\s\S]*?\})\s*```/g,  // JSON code blocks
                /\{[\s\S]*?"type"[\s\S]*?"datapointId"[\s\S]*?\}/g,  // Individual action patterns
                /\{[\s\S]*?"actions"[\s\S]*?\[[\s\S]*?\][\s\S]*?\}/g  // Full actions array pattern
            ];
            
            for (const pattern of jsonPatterns) {
                let match;
                while ((match = pattern.exec(responseText)) !== null) {
                    try {
                        const jsonStr = match[1] || match[0];  // Use capture group if available
                        this.log.debug(`[JSON] Found potential JSON: ${jsonStr}`);
                        
                        const actionData = JSON.parse(jsonStr);
                        
                        if (actionData.actions && Array.isArray(actionData.actions)) {
                            this.log.info(`[JSON] Found ${actionData.actions.length} actions to execute`);
                            
                            for (const action of actionData.actions) {
                                try {
                                    this.log.debug(`[JSON] Executing action: ${JSON.stringify(action)}`);
                                    const actionResult = await this.executeJsonAction(action, modelId);
                                    results.push(actionResult);
                                    this.log.info(`[JSON] Action executed successfully: ${action.type} - ${JSON.stringify(actionResult)}`);
                                } catch (actionError) {
                                    this.log.error(`[JSON] Error executing action: ${actionError.message}`);
                                    results.push({ error: actionError.message, action });
                                }
                            }
                        } else if (actionData.type && actionData.datapointId) {
                            // Handle individual action
                            try {
                                this.log.debug(`[JSON] Executing individual action: ${JSON.stringify(actionData)}`);
                                const actionResult = await this.executeJsonAction(actionData, modelId);
                                results.push(actionResult);
                                this.log.info(`[JSON] Individual action executed successfully: ${actionData.type} - ${JSON.stringify(actionResult)}`);
                            } catch (actionError) {
                                this.log.error(`[JSON] Error executing individual action: ${actionError.message}`);
                                results.push({ error: actionError.message, action: actionData });
                            }
                        }
                    } catch (parseError) {
                        this.log.debug(`[JSON] Failed to parse JSON: ${parseError.message}`);
                    }
                }
            }
        } catch (error) {
            this.log.error(`[JSON] Error processing JSON actions: ${error.message}`);
        }

        this.log.debug(`[JSON] Total results: ${results.length}`);
        return results;
    }

    /**
     * Execute a single JSON action
     */
    async executeJsonAction(action, modelId) {
        if (!this._datapointController) {
            throw new Error('Datapoint controller is not initialized');
        }

        if (!action.type) {
            throw new Error('Action type is required');
        }

        this.log.debug(`[JSON] Executing action type: ${action.type} with params: ${JSON.stringify(action)}`);

        switch (action.type) {
            case 'setDatapointValue':
                if (!action.datapointId || action.value === undefined) {
                    throw new Error('datapointId and value are required for setDatapointValue');
                }
                this.log.debug(`[JSON] Setting datapoint ${action.datapointId} to ${action.value}`);
                return await this._datapointController.executeFunctionCall(
                    'setDatapointValue',
                    { datapointId: action.datapointId, value: action.value },
                    modelId
                );

            case 'getDatapointValue':
                if (!action.datapointId) {
                    throw new Error('datapointId is required for getDatapointValue');
                }
                this.log.debug(`[JSON] Getting datapoint value for ${action.datapointId}`);
                return await this._datapointController.executeFunctionCall(
                    'getDatapointValue',
                    { datapointId: action.datapointId },
                    modelId
                );

            case 'searchDatapoints':
                if (!action.query) {
                    throw new Error('query is required for searchDatapoints');
                }
                this.log.debug(`[JSON] Searching datapoints with query: ${action.query}`);
                return await this._datapointController.executeFunctionCall(
                    'searchDatapoints',
                    { 
                        query: action.query,
                        type: action.type || undefined,
                        location: action.location || undefined
                    },
                    modelId
                );

            case 'incrementDatapoint':
                if (!action.datapointId || action.amount === undefined) {
                    throw new Error('datapointId and amount are required for incrementDatapoint');
                }
                this.log.debug(`[JSON] Incrementing datapoint ${action.datapointId} by ${action.amount}`);
                return await this._datapointController.executeFunctionCall(
                    'incrementDatapoint',
                    { datapointId: action.datapointId, amount: action.amount },
                    modelId
                );

            default:
                throw new Error(`Unknown action type: ${action.type}`);
        }
    }

    /**
     * Configure datapoint control
     */
    configureDatapointControl(enabled, allowedDatapoints = new Set()) {
        this._datapointControlEnabled = enabled;
        this._allowedDatapoints = allowedDatapoints;
        
        this.log.debug(`[AI] Configuring datapoint control: enabled=${enabled}, allowedDatapoints=${allowedDatapoints.size}`);
        
        if (enabled) {
            this._datapointController = new DatapointController(this.adapter, this.log);
            this._datapointController.setAllowedDatapoints(allowedDatapoints);
            this.log.info(`[AI] Structured JSON control enabled for ${allowedDatapoints.size} datapoints`);
            
            // Debug: Log all allowed datapoints
            if (allowedDatapoints.size > 0) {
                this.log.debug(`[AI] Allowed datapoints: ${Array.from(allowedDatapoints).join(', ')}`);
            }
        } else {
            this._datapointController = null;
            this.log.info('[AI] Datapoint control disabled');
        }
    }

    /**
     * Update allowed datapoints
     */
    updateAllowedDatapoints(allowedDatapoints) {
        this._allowedDatapoints = allowedDatapoints;
        this.log.debug(`[AI] Updating allowed datapoints: ${allowedDatapoints.size} datapoints`);
        
        if (allowedDatapoints.size > 0) {
            this.log.debug(`[AI] Updated allowed datapoints: ${Array.from(allowedDatapoints).join(', ')}`);
        }
        
        if (this._datapointController) {
            this._datapointController.setAllowedDatapoints(allowedDatapoints);
        }
    }

    /**
     * Fetch available models
     */
    async fetchModels() {
        try {
            const resp = await this._axios.get(`${this._serverUrlBase}/api/tags`, { timeout: 10000 });
            return resp.data.models.map(model => model.name);
        } catch (error) {
            this.log.error(`Error fetching models: ${error.message}`);
            return [];
        }
    }

    /**
     * Check running models
     */
    async checkRunningModels() {
        try {
            const resp = await this._axios.get(`${this._serverUrlBase}/api/ps`, { timeout: 10000 });
            return resp.data.models || [];
        } catch (error) {
            this.log.error(`Error checking running models: ${error.message}`);
            return [];
        }
    }

    /**
     * Start model monitoring (simplified)
     */
    startMonitor(models, namespace, intervalMs) {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
        }
        
        // Initial check
        this._runMonitor(models, namespace);
        
        if (intervalMs > 0) {
            this._monitorInterval = setInterval(() => {
                this._runMonitor(models, namespace);
            }, intervalMs);
        }
    }

    /**
     * Stop model monitoring
     */
    stopMonitor() {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
        }
    }

    /**
     * Run monitor check
     */
    async _runMonitor(models, namespace) {
        try {
            const runningProcesses = await this.checkRunningModels();
            const runningNames = models
                .filter(m => runningProcesses.some(p => p.name === m.name || p.model === m.name))
                .map(m => m.name);
            
            this.log.debug(`Running models: ${runningNames.length ? runningNames.join(', ') : 'none'}`);
            
            // Update running states
            for (const model of models) {
                const isRunning = runningNames.includes(model.name);
                await this.adapter.setState(`models.${model.id}.running`, isRunning, true);
            }
        } catch (error) {
            this.log.error(`Monitor error: ${error.message}`);
        }
    }

    /**
     * Test method to verify JSON action parsing
     */
    testJsonActionParsing(testResponse) {
        this.log.info(`[TEST] Testing JSON action parsing with response: ${testResponse}`);
        
        const jsonPatterns = [
            /\{[\s\S]*?"actions"[\s\S]*?\}/g,
            /```json\s*(\{[\s\S]*?\})\s*```/g,
            /\{[\s\S]*?"type"[\sS]*?"datapointId"[\sS]*?\}/g
        ];
        
        let jsonMatches = [];
        
        for (const pattern of jsonPatterns) {
            const matches = testResponse.match(pattern);
            if (matches) {
                this.log.info(`[TEST] Pattern matched: ${pattern} - Found ${matches.length} matches`);
                jsonMatches = jsonMatches.concat(matches);
            }
        }
        
        if (jsonMatches.length === 0) {
            this.log.warn(`[TEST] No JSON actions found in test response`);
            return false;
        }
        
        for (const jsonMatch of jsonMatches) {
            try {
                let cleanJsonString = jsonMatch.replace(/```json\s*/, '').replace(/\s*```/, '');
                const jsonData = JSON.parse(cleanJsonString);
                this.log.info(`[TEST] Successfully parsed JSON: ${JSON.stringify(jsonData)}`);
                
                if (jsonData.actions && Array.isArray(jsonData.actions)) {
                    this.log.info(`[TEST] Found ${jsonData.actions.length} actions`);
                    return true;
                }
            } catch (error) {
                this.log.error(`[TEST] Failed to parse JSON: ${error.message}`);
            }
        }
        
        return false;
    }
}

module.exports = OllamaClient;
