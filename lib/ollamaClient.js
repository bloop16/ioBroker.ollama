"use strict";

const axios = require("axios");

class OllamaClient {
    /**
     * @param {string} openWebUIUrl - OpenWebUI server URL for chat API
     * @param {string} ollamaUrl - Direct Ollama server URL for status monitoring
     * @param {object} logger
     * @param {string} [apiKey]
     * @param {function} [setStateCallback] - Callback function for setting states
     */
    constructor(openWebUIUrl, ollamaUrl, logger, apiKey, setStateCallback) {
        this._openWebUIUrl = openWebUIUrl;
        this._ollamaUrl = ollamaUrl;
        this._axios = axios;
        this.log = logger;
        this._apiKey = apiKey || "";
        this._monitorInterval = null;
        this._setStateCallback = setStateCallback;
        
        this.log.debug(`[OllamaClient] Initialized with OpenWebUI: ${openWebUIUrl}, Ollama: ${ollamaUrl}`);
    }

    /**
     * Fetch available models from OpenWebUI with improved error handling
     */
    async fetchModels() {
        // First try OpenWebUI if API key is configured
        if (this._apiKey && this._apiKey.trim() !== '') {
            try {
                const headers = {
                    'Authorization': `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json'
                };
                
                this.log.debug(`[API] Trying to fetch models from OpenWebUI: ${this._openWebUIUrl}/api/models`);
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
                
                this.log.warn('[OpenWebUI] Unexpected response format, trying direct Ollama...');
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
                            this.log.warn(`[OpenWebUI] HTTP Error ${status}: ${error.response.statusText || 'Unknown'}`);
                    }
                } else if (error.code === 'ECONNREFUSED') {
                    this.log.warn(`[OpenWebUI] Connection refused - Is OpenWebUI running on ${this._openWebUIUrl}?`);
                } else {
                    this.log.warn(`[OpenWebUI] Error fetching models: ${error.message}`);
                }
                
                this.log.info('[Fallback] Trying direct Ollama connection...');
            }
        } else {
            this.log.debug('[OpenWebUI] No API key configured, using direct Ollama connection');
        }
        
        // Fallback to direct Ollama
        try {
            this.log.debug(`[API] Trying to fetch models from Ollama: ${this._ollamaUrl}/api/tags`);
            const resp = await this._axios.get(`${this._ollamaUrl}/api/tags`, { timeout: 10000 });
            
            if (resp.data && resp.data.models) {
                const models = resp.data.models.map(model => model.name);
                this.log.info(`[Ollama] Successfully fetched ${models.length} models via direct connection`);
                return models;
            }
            
            this.log.warn('[Ollama] No models found in response');
            return [];
        } catch (fallbackError) {
            if (fallbackError.code === 'ECONNREFUSED') {
                this.log.error(`[Ollama] Connection refused - Is Ollama running on ${this._ollamaUrl}?`);
            } else {
                this.log.error(`[Ollama] Error fetching models: ${fallbackError.message}`);
            }
            
            this.log.error('[Connection] Both OpenWebUI and direct Ollama connections failed');
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
     * Process simple chat message via OpenWebUI
     */
    async processChatMessage(modelName, messageObj, options = {}) {
        if (!modelName || !messageObj || !messageObj.content) {
            this.log.error(`[API] Invalid inputs for model ${modelName}`);
            return null;
        }
        
        this.log.debug(`[API] Processing simple chat for model: "${modelName}"`);

        try {
            // Simple message structure - just the user input
            const messages = [{
                role: messageObj.role || "user",
                content: messageObj.content
            }];

            // Build simple OpenWebUI payload
            const payload = {
                model: modelName,
                messages: messages,
                stream: false,
                temperature: 0.7,
                max_tokens: 2048
            };

            // Add custom options if provided
            if (options.options && typeof options.options === 'string' && options.options !== "{}") {
                try {
                    const customOptions = JSON.parse(options.options);
                    if (customOptions.temperature) payload.temperature = customOptions.temperature;
                    if (customOptions.max_tokens) payload.max_tokens = customOptions.max_tokens;
                } catch (err) {
                    this.log.warn(`[API] Invalid options JSON: ${options.options}`);
                }
            }

            this.log.debug(`[API] Sending to OpenWebUI: ${JSON.stringify(payload)}`);

            // Send to OpenWebUI
            const response = await this.sendChatPayload(payload);
            
            if (response && response.choices && response.choices[0]) {
                const answer = response.choices[0].message?.content || '';
                this.log.debug(`[API] Received response: ${answer.substring(0, 100)}...`);
                
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
            this.log.error(`Error processing chat message: ${error.message}`);
            return null;
        }
    }

    /**
     * Send simple chat payload to OpenWebUI server
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
     * Test OpenWebUI connection and API key validity
     */
    async testOpenWebUIConnection() {
        try {
            this.log.debug('[OpenWebUI] Testing connection and API key...');
            
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
