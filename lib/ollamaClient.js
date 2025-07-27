"use strict";

const axios = require("axios");

class OllamaClient {
    /**
     * @param {string} openWebUIUrl - OpenWebUI server URL for chat API
     * @param {string} ollamaUrl - Direct Ollama server URL for status monitoring
     * @param {object} logger
     * @param {string} [apiKey]
     * @param {function} [setStateCallback] - Callback function for setting states
     * @param {string} [toolServerUrl] - Tool Server URL for tool integration
     * @param {object} [config] - Adapter configuration
     */
    constructor(openWebUIUrl, ollamaUrl, logger, apiKey, setStateCallback, toolServerUrl, config) {
        this._openWebUIUrl = openWebUIUrl;
        this._ollamaUrl = ollamaUrl;
        this._toolServerUrl = toolServerUrl || 'http://localhost:9099';
        this._axios = axios;
        this.log = logger;
        this._apiKey = apiKey || "";
        this._monitorInterval = null;
        this._setStateCallback = setStateCallback;
        this.config = config || {};
        
        this.log.debug(`[OllamaClient] Initialized with OpenWebUI: ${openWebUIUrl}, Ollama: ${ollamaUrl}, ToolServer: ${this._toolServerUrl}`);
    }

    /**
     * Fetch available models from OpenWebUI only
     */
    async fetchModels() {
        // Only try OpenWebUI - no Ollama fallback for model discovery
        if (this._apiKey && this._apiKey.trim() !== '') {
            try {
                const headers = {
                    'Authorization': `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json'
                };
                
                this.log.debug(`[API] Fetching models from OpenWebUI: ${this._openWebUIUrl}/api/models`);
                const resp = await this._axios.get(`${this._openWebUIUrl}/api/models`, { 
                    headers,
                    timeout: 10000 
                });
                
                // OpenWebUI returns models in different format
                if (resp.data && resp.data.data) {
                    const models = resp.data.data.map(model => model.id || model.name);
                    this.log.info(`[OpenWebUI] Successfully fetched ${models.length} models`);
                    return models;
                } else if (resp.data && Array.isArray(resp.data)) {
                    const models = resp.data.map(model => model.id || model.name);
                    this.log.info(`[OpenWebUI] Successfully fetched ${models.length} models`);
                    return models;
                }
                
                this.log.error('[OpenWebUI] Unexpected response format from OpenWebUI');
                return [];
            } catch (error) {
                if (error.response) {
                    const status = error.response.status;
                    switch (status) {
                        case 401:
                            this.log.error('[OpenWebUI] Authentication failed - Invalid API key');
                            break;
                        case 403:
                            this.log.error('[OpenWebUI] Access forbidden - Check API key permissions');
                            break;
                        default:
                            this.log.error(`[OpenWebUI] HTTP Error ${status}: ${error.response.statusText || 'Unknown'}`);
                    }
                } else if (error.code === 'ECONNREFUSED') {
                    this.log.error(`[OpenWebUI] Connection refused - Is OpenWebUI running on ${this._openWebUIUrl}?`);
                } else {
                    this.log.error(`[OpenWebUI] Error fetching models: ${error.message}`);
                }
                
                this.log.error('[OpenWebUI] Model fetching failed - OpenWebUI connection required');
                return [];
            }
        } else {
            this.log.error('[OpenWebUI] No API key configured - OpenWebUI connection required for model discovery');
            return [];
        }
    }

    /**
     * Check running models via direct Ollama connection
     */
    async checkRunningModels() {
        try {
            // Use direct Ollama connection for status monitoring
            const resp = await this._axios.get(`${this._ollamaUrl}/api/ps`, { timeout: 10000 });
            return resp.data.models || [];
        } catch (error) {
            this.log.debug(`[Monitor] Error checking running models: ${error.message}`);
            return [];
        }
    }

    /**
     * Process chat message via Tool Server with OpenWebUI as primary backend
     */
    async processChatMessage(modelName, messageObj, options = {}) {
        if (!modelName || !messageObj || !messageObj.content) {
            this.log.error(`[API] Invalid inputs for model ${modelName}`);
            return null;
        }
        
        this.log.debug(`[API] Processing chat via Tool Server for model: "${modelName}"`);

        try {
            // Check if Tool Server is available
            const toolServerAvailable = await this._checkToolServerAvailability();
            
            if (toolServerAvailable) {
                // Use Tool Server for complete chat processing with RAG
                return await this._processChatViaToolServer(modelName, messageObj, options);
            } else {
                // No fallback to direct Ollama - OpenWebUI only
                this.log.error(`[API] Tool Server not available - OpenWebUI connection required for reliable results`);
                throw new Error('Tool Server unavailable - cannot process chat request without RAG integration');
            }

        } catch (error) {
            this.log.error(`Error processing chat message: ${error.message}`);
            return null;
        }
    }

    /**
     * Process chat via Tool Server with RAG integration
     */
    async _processChatViaToolServer(modelName, messageObj, options = {}) {
        try {
            const messages = [{
                role: messageObj.role || "user",
                content: messageObj.content
            }];

            const payload = {
                model: modelName,
                messages: messages,
                temperature: this.config?.temperature ?? 0.7,
                max_tokens: this.config?.maxTokens ?? 2048,
                use_rag: true
            };

            // Add custom options if provided (these override config values)
            if (options.options && typeof options.options === 'string' && options.options !== "{}") {
                try {
                    const customOptions = JSON.parse(options.options);
                    if (customOptions.temperature !== undefined) payload.temperature = customOptions.temperature;
                    if (customOptions.max_tokens !== undefined) payload.max_tokens = customOptions.max_tokens;
                    if (customOptions.use_rag !== undefined) payload.use_rag = customOptions.use_rag;
                } catch (err) {
                    this.log.warn(`[API] Invalid options JSON: ${options.options}`);
                }
            }

            this.log.debug(`[API] Sending to Tool Server: ${JSON.stringify(payload)}`);

            const response = await this._axios.post(`${this._toolServerUrl}/chat/completions`, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 60000
            });

            if (response.data?.choices?.[0]?.message?.content) {
                const answer = response.data.choices[0].message.content;
                const ragContext = response.data.rag_context || [];
                
                this.log.debug(`[API] Received response from Tool Server: ${answer.substring(0, 100)}...`);
                if (ragContext.length > 0) {
                    this.log.info(`[API] Tool Server used ${ragContext.length} RAG context items`);
                }
                
                return {
                    answer: answer,
                    toolCallResults: ragContext,
                    modelId: modelName.replace(/[^a-zA-Z0-9_]/g, "_")
                };
            } else {
                this.log.error(`[API] Invalid response structure from Tool Server`);
                return null;
            }

        } catch (error) {
            this.log.error(`[API] Tool Server request failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Process chat directly via OpenWebUI (OpenWebUI-only fallback)
     */
    async _processChatViaDirect(modelName, messageObj, options = {}) {
        // This method is kept for potential future use but should not be called
        // in normal operation as we want to avoid bypassing RAG integration
        this.log.warn(`[API] Direct OpenWebUI processing called - this bypasses RAG integration`);
        
        try {
            const messages = [{
                role: messageObj.role || "user",
                content: messageObj.content
            }];

            const payload = {
                model: modelName,
                messages: messages,
                stream: false,
                temperature: this.config?.temperature ?? 0.7,
                max_tokens: this.config?.maxTokens ?? 2048
            };

            // Add custom options if provided (these override config values)
            if (options.options && typeof options.options === 'string' && options.options !== "{}") {
                try {
                    const customOptions = JSON.parse(options.options);
                    if (customOptions.temperature !== undefined) payload.temperature = customOptions.temperature;
                    if (customOptions.max_tokens !== undefined) payload.max_tokens = customOptions.max_tokens;
                } catch (err) {
                    this.log.warn(`[API] Invalid options JSON: ${options.options}`);
                }
            }

            this.log.debug(`[API] Sending direct to OpenWebUI: ${JSON.stringify(payload)}`);

            const response = await this.sendChatPayload(payload);
            
            if (response && response.choices && response.choices[0]) {
                const answer = response.choices[0].message?.content || '';
                this.log.warn(`[API] Direct response without RAG: ${answer.substring(0, 100)}...`);
                
                return {
                    answer: answer,
                    toolCallResults: [],
                    modelId: modelName.replace(/[^a-zA-Z0-9_]/g, "_")
                };
            } else {
                this.log.error(`[API] Invalid response structure from OpenWebUI`);
                return null;
            }

        } catch (error) {
            this.log.error(`[API] Direct OpenWebUI request failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check if Tool Server is available
     */
    async _checkToolServerAvailability() {
        try {
            const response = await this._axios.get(`${this._toolServerUrl}/health`, { 
                timeout: 3000 
            });
            return response.status === 200;
        } catch (error) {
            this.log.debug(`[Tools] Tool Server not available: ${error.message}`);
            return false;
        }
    }

    /**
     * Send simple chat payload to OpenWebUI server only
     */
    async sendChatPayload(payload) {
        try {
            // Prepare headers for OpenWebUI
            const headers = {
                "Content-Type": "application/json"
            };
            
            // Add Authorization header if API key is provided
            if (this._apiKey) {
                headers['Authorization'] = `Bearer ${this._apiKey}`;
            } else {
                this.log.error('[API] No API key configured - OpenWebUI authentication required');
                throw new Error('OpenWebUI API key required for chat requests');
            }
            
            this.log.debug(`[API] Sending to ${this._openWebUIUrl}/api/chat/completions`);
            
            const resp = await this._axios.post(
                `${this._openWebUIUrl}/api/chat/completions`,
                payload,
                { headers, timeout: 60000 }
            );
            
            return resp.data;
            
        } catch (error) {
            if (error.response) {
                this.log.error(`Error sending chat payload to OpenWebUI: ${error.message}`);
                this.log.error(`Response status: ${error.response.status}`);
                this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
            } else {
                this.log.error(`Network error sending to OpenWebUI: ${error.message}`);
            }
            throw error;
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
                if (this._setStateCallback) {
                    await this._setStateCallback(`models.${model.id}.running`, isRunning, true);
                }
            }
        } catch (error) {
            this.log.error(`Monitor error: ${error.message}`);
        }
    }

    /**
     * Process chat message from ioBroker state change with full state management
     */
    async processStateBasedChatMessage(id, state, adapter) {
        if (!adapter.ollamaClient) {
            adapter.log.error("OllamaClient is not initialized.");
            return;
        }

        try {
            // Extract model information
            const modelMatch = id.match(/models\.([^.]+)\.messages\.content$/);
            if (!modelMatch) {
                adapter.log.error(`Invalid state ID format: ${id}`);
                return;
            }
            
            const modelId = modelMatch[1];
            
            // Check if model is already processing
            const processingState = await adapter.getStateAsync(`models.${modelId}.processing`);
            if (processingState?.val === true) {
                adapter.log.warn(`[API] Model ${modelId} is already processing a request. Ignoring new request.`);
                return;
            }
            
            // Set processing state
            await adapter.setState(`models.${modelId}.processing`, true, true);
            
            try {
                // Get the original model name from the stored state
                const originalNameState = await adapter.getStateAsync(`models.${modelId}.originalName`);
                const modelName = originalNameState?.val || modelId.replace(/_/g, ':');
                
                // Get essential states
                const [roleState, contentState, optionsState] = await Promise.all([
                    adapter.getStateAsync(`models.${modelId}.messages.role`),
                    adapter.getStateAsync(`models.${modelId}.messages.content`),
                    adapter.getStateAsync(`models.${modelId}.options`)
                ]);

                // Build message object
                const messageObj = {
                    role: roleState?.val || "user",
                    content: contentState?.val || ""
                };

                // Process message
                const result = await this.processChatMessage(modelName, messageObj, {
                    options: optionsState?.val,
                    stream: false
                });

                if (result) {
                    // Set response state (content and response are the same, only need one)
                    await adapter.setState(`models.${modelId}.response`, result.answer || "", true);
                    
                    if (result.toolCallResults?.length > 0) {
                        adapter.log.info(`[AI] Model ${modelName} executed ${result.toolCallResults.length} actions`);
                    }
                } else {
                    adapter.log.error(`[API] No result received from model ${modelName}`);
                }
            } finally {
                // Always clear processing state
                await adapter.setState(`models.${modelId}.processing`, false, true);
            }
        } catch (error) {
            adapter.log.error(`Error processing chat message: ${error.message}`);
        }
    }

    /**
     * Create ioBroker states for all available models
     */
    async createModelStates(models, adapter) {
        await adapter.setObjectNotExistsAsync("models", { 
            type: "folder", 
            common: { name: adapter.translate("Ollama Models") }, 
            native: {} 
        });
        
        // Create vector database management state
        if (adapter.config.useVectorDb) {
            await adapter.setObjectNotExistsAsync("vectordb", { 
                type: "channel", 
                common: { name: adapter.translate("Vector Database") }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync("vectordb.cleanup", { 
                type: "state", 
                common: { 
                    name: adapter.translate("Clean up duplicates"), 
                    type: "boolean", 
                    role: "button", 
                    read: true, 
                    write: true, 
                    def: false 
                }, 
                native: {} 
            });
        }
        
        for (const model of models) {
            const modelId = model.replace(/[^a-zA-Z0-9_]/g, "_");
            
            adapter.log.debug(`[Setup] Creating states for model '${model}' with ID '${modelId}'`);
            
            // Essential states
            await adapter.setObjectNotExistsAsync(`models.${modelId}`, { 
                type: "channel", 
                common: { name: model }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.response`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Response"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: false 
                }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.running`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Running"), 
                    type: "boolean", 
                    role: "indicator.running", 
                    read: true, 
                    write: false, 
                    def: false 
                }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.processing`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Processing"), 
                    type: "boolean", 
                    role: "indicator.working", 
                    read: true, 
                    write: false, 
                    def: false 
                }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.content`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Response Content"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: false 
                }, 
                native: {} 
            });
            
            // Message states
            await adapter.setObjectNotExistsAsync(`models.${modelId}.messages`, { 
                type: "channel", 
                common: { name: adapter.translate("Messages") }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.messages.role`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Role"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: true, 
                    def: "user" 
                }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.messages.content`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Content"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: true, 
                    def: "" 
                }, 
                native: {} 
            });
            await adapter.setObjectNotExistsAsync(`models.${modelId}.options`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Options (JSON)"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: true, 
                    def: "{}" 
                }, 
                native: {} 
            });

            // Store original model name for later retrieval
            await adapter.setObjectNotExistsAsync(`models.${modelId}.originalName`, { 
                type: "state", 
                common: { 
                    name: adapter.translate("Original Model Name"), 
                    type: "string", 
                    role: "state", 
                    read: true, 
                    write: false, 
                    def: model 
                }, 
                native: {} 
            });
            await adapter.setState(`models.${modelId}.originalName`, model, true);

            // Add model entry for monitoring
            adapter._models.push({ name: model, id: modelId });
        }
    }

    /**
     * Test OpenWebUI connection and API key validity - required for all operations
     */
    async testOpenWebUIConnection() {
        try {
            this.log.debug('[OpenWebUI] Testing connection and API key...');
            
            if (!this._apiKey || this._apiKey.trim() === '') {
                this.log.error('[OpenWebUI] No API key configured - OpenWebUI authentication required');
                return false;
            }

            const headers = {
                'Authorization': `Bearer ${this._apiKey}`,
                'Content-Type': 'application/json'
            };

            const response = await this._axios.get(`${this._openWebUIUrl}/api/models`, {
                headers,
                timeout: 10000
            });

            if (response.status === 200) {
                this.log.info('[OpenWebUI] Connection successful and API key valid');
                
                if (response.data?.data) {
                    const modelCount = response.data.data.length;
                    this.log.debug(`[OpenWebUI] Found ${modelCount} models available`);
                }
                
                return true;
            } else {
                this.log.error(`[OpenWebUI] Unexpected response status: ${response.status}`);
                return false;
            }
        } catch (error) {
            if (error.response) {
                const status = error.response.status;
                const statusText = error.response.statusText || 'Unknown';
                
                switch (status) {
                    case 401:
                        this.log.error('[OpenWebUI] Authentication failed - Invalid API key');
                        break;
                    case 403:
                        this.log.error('[OpenWebUI] Access forbidden - Check API key permissions');
                        break;
                    case 404:
                        this.log.error('[OpenWebUI] API endpoint not found - Check OpenWebUI version');
                        break;
                    default:
                        this.log.error(`[OpenWebUI] HTTP Error ${status}: ${statusText}`);
                }
            } else if (error.code === 'ECONNREFUSED') {
                this.log.error(`[OpenWebUI] Connection refused to ${this._openWebUIUrl} - Is OpenWebUI running?`);
            } else if (error.code === 'ETIMEDOUT') {
                this.log.error(`[OpenWebUI] Connection timeout to ${this._openWebUIUrl}`);
            } else {
                this.log.error(`[OpenWebUI] Connection test failed: ${error.message}`);
            }
            return false;
        }
    }

}

module.exports = OllamaClient;
