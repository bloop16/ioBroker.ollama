"use strict";

const express = require("express");
const cors = require("cors");
const { QdrantClient } = require("@qdrant/qdrant-js");
const axios = require("axios");
const ToolServerController = require("./toolServerController");

/**
 * OpenWebUI Tool Server for ioBroker Qdrant Vector Database Integration
 * Provides RAG (Retrieval Augmented Generation) functionality as OpenAPI tool
 */
class ToolServer {
    /**
     * @param {object} config - Adapter configuration
     * @param {object} log - Logger instance
     * @param {Set} enabledDatapoints - Set of enabled datapoints for context
     * @param {object} datapointController - DatapointController for function calling
     */
    constructor(config, log, enabledDatapoints, datapointController) {
        this.config = config;
        this.log = log;
        this.enabledDatapoints = enabledDatapoints;
        this.datapointController = datapointController;
        
        this.app = express();
        this.server = null;
        this.qdrantClient = null;
        this.controller = new ToolServerController();
        
        // Server configuration
        this.host = config.toolServerHost || "0.0.0.0";
        this.port = config.toolServerPort || 9099;
        this.collectionName = config.vectorDbCollection || "iobroker_datapoints";
        
        // OpenWebUI/Ollama configuration
        this.openWebUIUrl = `http://${config.openWebUIIp}:${config.openWebUIPort}`;
        this.embeddingModel = config.embeddingModel || "nomic-embed-text";
        this.chatModel = config.toolServerChatModel || "llama3.2";
        this.apiKey = config.openWebUIApiKey || "";
        
        this._setupExpress();
        this._setupRoutes();
        this._setupCleanup();
    }

    /**
     * Setup cleanup handlers for graceful shutdown
     */
    _setupCleanup() {
        // Clean up on process exit
        process.on('exit', () => {
            this.controller.cleanup();
        });
        
        process.on('SIGINT', () => {
            this.controller.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', () => {
            this.controller.cleanup();
            process.exit(0);
        });
    }

    /**
     * Setup Express middleware
     */
    _setupExpress() {
        // Enable CORS for OpenWebUI integration
        this.app.use(cors());
        
        // Parse JSON bodies
        this.app.use(express.json({ limit: '10mb' }));
        
        // Basic error handling
        this.app.use((error, req, res, next) => {
            this.log.error(`[ToolServer] Express error: ${error.message}`);
            res.status(500).json({ error: "Internal server error" });
        });
    }

    /**
     * Setup API routes for OpenWebUI integration
     */
    _setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: "healthy",
                timestamp: new Date().toISOString(),
                service: "ioBroker Ollama Tool Server"
            });
        });

        // OpenAPI specification for OpenWebUI tool discovery
        this.app.get('/openapi.json', (req, res) => {
            const openApiSpec = {
                openapi: "3.0.0",
                info: {
                    title: "ioBroker Qdrant RAG Tool",
                    version: "1.0.0",
                    description: "Retrieval Augmented Generation tool for ioBroker datapoints using Qdrant vector database"
                },
                servers: [{
                    url: `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}`,
                    description: "ioBroker Tool Server"
                }],
                paths: {
                    "/tools/iobroker-rag": {
                        post: {
                            summary: "Query ioBroker datapoints with RAG",
                            description: "Searches ioBroker datapoint history using vector similarity and provides contextual answers. Automatically processes datapoint changes when detected in natural language.",
                            operationId: "queryIoBrokerRAG",
                            requestBody: {
                                required: true,
                                content: {
                                    "application/json": {
                                        schema: {
                                            type: "object",
                                            properties: {
                                                query: {
                                                    type: "string",
                                                    description: "User question about smart home status, devices, or natural language commands like 'Martin ist jetzt anwesend'"
                                                },
                                                max_results: {
                                                    type: "integer",
                                                    default: 5,
                                                    description: "Maximum number of relevant datapoints to include in context"
                                                }
                                            },
                                            required: ["query"]
                                        }
                                    }
                                }
                            },
                            responses: {
                                "200": {
                                    description: "Successful response with contextual answer and automatic datapoint changes",
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object",
                                                properties: {
                                                    answer: {
                                                        type: "string",
                                                        description: "AI-generated answer based on relevant datapoint context"
                                                    },
                                                    context_used: {
                                                        type: "array",
                                                        description: "List of datapoints that were used for context",
                                                        items: {
                                                            type: "object",
                                                            properties: {
                                                                datapoint_id: { type: "string" },
                                                                description: { type: "string" },
                                                                value: { type: "string" },
                                                                timestamp: { type: "string" }
                                                            }
                                                        }
                                                    },
                                                    datapoint_changes: {
                                                        type: "array",
                                                        description: "Automatic datapoint changes that were applied",
                                                        items: {
                                                            type: "object",
                                                            properties: {
                                                                datapointId: { type: "string" },
                                                                originalValue: { type: "string" },
                                                                convertedValue: {},
                                                                reasoning: { type: "string" }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                },
                                "400": {
                                    description: "Invalid request"
                                },
                                "500": {
                                    description: "Internal server error"
                                }
                            }
                        }
                    }
                }
            };
            
            res.json(openApiSpec);
        });

        // Main RAG tool endpoint
        this.app.post('/tools/iobroker-rag', async (req, res) => {
            try {
                const { query, max_results = 5 } = req.body;
                
                if (!query || typeof query !== 'string') {
                    return res.status(400).json({ error: "Query parameter is required and must be a string" });
                }

                this.log.debug(`[ToolServer] RAG query received: "${query}"`);
                
                const result = await this._processRAGQuery(query, max_results);
                res.json(result);
                
            } catch (error) {
                this.log.error(`[ToolServer] RAG query error: ${error.message}`);
                res.status(500).json({ error: "Failed to process RAG query" });
            }
        });

        // Natural language datapoint control endpoint
        this.app.post('/tools/set-datapoint', async (req, res) => {
            try {
                const { message, model = 'assistant' } = req.body;
                
                if (!message || typeof message !== 'string') {
                    return res.status(400).json({ error: "Message parameter is required and must be a string" });
                }

                this.log.info(`[ToolServer] Natural language datapoint control request: "${message}"`);
                
                const result = await this._processNaturalLanguageDatapointControl(message, model);
                res.json(result);
                
            } catch (error) {
                this.log.error(`[ToolServer] Datapoint control error: ${error.message}`);
                res.status(500).json({ error: "Failed to process datapoint control request", details: error.message });
            }
        });

                // Complete chat processing endpoint for ioBroker adapter
        this.app.post('/chat/completions', async (req, res) => {
            try {
                const { model, messages, temperature = 0.7, max_tokens = 2048, use_rag = true } = req.body;
                
                if (!model || !messages || !Array.isArray(messages)) {
                    return res.status(400).json({ error: "model and messages are required" });
                }

                const userMessage = messages[messages.length - 1];
                if (!userMessage || !userMessage.content) {
                    return res.status(400).json({ error: "Valid user message required" });
                }

                this.log.debug(`[ToolServer] Processing complete chat for model: ${model}`);
                
                const result = await this._processCompleteChat({
                    model,
                    messages,
                    temperature,
                    max_tokens,
                    use_rag
                });
                
                res.json(result);
                
            } catch (error) {
                this.log.error(`[ToolServer] Complete chat error: ${error.message}`);
                res.status(500).json({ error: "Failed to process chat" });
            }
        });

        // Alternative endpoint for compatibility with existing Python solution
        this.app.post('/tools/get_iobroker_data_answer', async (req, res) => {
            try {
                const { user_query, options = {} } = req.body;
                
                if (!user_query) {
                    return res.status(400).json({ error: "user_query is required" });
                }

                this.log.debug(`[ToolServer] Legacy RAG query: "${user_query}"`);
                
                const result = await this._processRAGQuery(user_query, options.max_results || 5);
                
                // Return in legacy format
                res.json({ answer: result.answer });
                
            } catch (error) {
                this.log.error(`[ToolServer] Legacy RAG query error: ${error.message}`);
                res.status(500).json({ error: "Failed to process query" });
            }
        });
    }

    /**
     * Process complete chat with automatic RAG integration and datapoint control
     * @param {object} chatRequest - Chat request object
     * @returns {Promise<object>} Complete chat response
     */
    async _processCompleteChat(chatRequest) {
        const { model, messages, temperature = 0.7, max_tokens = 2048, use_rag = true } = chatRequest;
        
        try {
            const userMessage = messages[messages.length - 1];
            const userQuery = userMessage.content;
            
            let finalMessages = [...messages];
            let contextUsed = [];
            let contextResults = [];
            let datapointChanges = [];
            
            // Apply RAG if enabled and vector database is available
            if (use_rag && this.qdrantClient) {
                try {
                    this.log.debug(`[ToolServer] Applying RAG for query: "${userQuery}"`);
                    
                    // Generate embedding and search for relevant context
                    const queryEmbedding = await this._generateEmbedding(userQuery);
                    contextResults = await this._searchSimilarDatapoints(queryEmbedding, 10); // Get more for better datapoint detection
                    
                    if (contextResults.length > 0) {
                        const context = this._buildContext(contextResults.slice(0, 5)); // Use top 5 for chat context
                        
                        // Enhance the user message with context
                        const enhancedContent = `Kontext aus ioBroker Datenpunkten:\n${context}\n\nBenutzeranfrage: ${userQuery}`;
                        
                        // Replace the last user message with enhanced version
                        finalMessages[finalMessages.length - 1] = {
                            ...userMessage,
                            content: enhancedContent
                        };
                        
                        contextUsed = contextResults.slice(0, 5).map(result => ({
                            datapoint_id: result.payload.datapoint_id,
                            description: result.payload.description,
                            value: result.payload.value,
                            timestamp: result.payload.timestamp,
                            score: result.score
                        }));
                        
                        this.log.debug(`[ToolServer] Enhanced query with ${contextResults.length} context items`);
                    }
                } catch (ragError) {
                    this.log.warn(`[ToolServer] RAG enhancement failed: ${ragError.message}`);
                    // Continue without RAG enhancement
                }
            }
            
            // AUTOMATIC DATAPOINT CONTROL: Check for potential datapoint changes
            if (this.datapointController && contextResults.length > 0) {
                try {
                    datapointChanges = await this._processAutomaticDatapointControl(userQuery, contextResults, model);
                } catch (controlError) {
                    this.log.warn(`[ToolServer] Automatic datapoint control failed: ${controlError.message}`);
                }
            }
            
            // Process chat with OpenWebUI/Ollama
            const chatResponse = await this._generateChatResponse(model, finalMessages, temperature, max_tokens);
            
            // Return in OpenWebUI-compatible format
            return {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: chatResponse
                    },
                    finish_reason: "stop"
                }],
                usage: {
                    prompt_tokens: 0, // We don't track tokens
                    completion_tokens: 0,
                    total_tokens: 0
                },
                rag_context: contextUsed, // Custom field for debugging
                datapoint_changes: datapointChanges // Custom field to show applied changes
            };
            
        } catch (error) {
            this.log.error(`[ToolServer] Complete chat processing error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate chat response using OpenWebUI/Ollama
     * @param {string} model - Model name
     * @param {Array} messages - Chat messages
     * @param {number} temperature - Temperature setting
     * @param {number} maxTokens - Max tokens
     * @returns {Promise<string>} Generated response
     */
    async _generateChatResponse(model, messages, temperature = 0.7, maxTokens = 2048) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.apiKey) {
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            }
            
            // Try OpenWebUI chat completions first
            try {
                const response = await axios.post(`${this.openWebUIUrl}/api/chat/completions`, {
                    model: model,
                    messages: messages,
                    stream: false,
                    temperature: temperature,
                    max_tokens: maxTokens
                }, { headers, timeout: 60000 });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return response.data.choices[0].message.content;
                }
                throw new Error('Invalid response format from OpenWebUI');
                
            } catch (openWebUIError) {
                this.log.debug(`[ToolServer] OpenWebUI chat failed: ${openWebUIError.message}, trying Ollama direct...`);
                
                // Fallback to direct Ollama API
                const ollamaUrl = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;
                
                // Convert messages to Ollama format
                const prompt = messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
                
                const ollamaResponse = await axios.post(`${ollamaUrl}/api/generate`, {
                    model: model,
                    prompt: prompt,
                    stream: false,
                    options: {
                        temperature: temperature,
                        num_predict: maxTokens
                    }
                }, { timeout: 60000 });
                
                if (ollamaResponse.data?.response) {
                    return ollamaResponse.data.response;
                }
                throw new Error('Invalid response format from Ollama');
            }
            
        } catch (error) {
            this.log.error(`[ToolServer] Chat generation error: ${error.message}`);
            throw new Error(`Failed to generate chat response: ${error.message}`);
        }
    }

    /**
     * Process automatic datapoint control based on natural language
     * Directly integrated into chat pipeline - like other successful adapters
     * @param {string} message - User message
     * @param {Array} contextResults - RAG context results
     * @param {string} modelId - Model identifier
     * @returns {Promise<Array>} Applied changes
     */
    async _processAutomaticDatapointControl(message, contextResults, modelId) {
        try {
            // Filter for datapoints that allow automatic changes (security)
            const changeableDatapoints = contextResults.filter(result => 
                result.payload.allowAutoChange === true || result.payload.allowAutoChange === 'true'
            );
            
            if (changeableDatapoints.length === 0) {
                this.log.debug(`[ToolServer] No datapoints with allowAutoChange found`);
                return [];
            }
            
            this.log.debug(`[ToolServer] Found ${changeableDatapoints.length} changeable datapoints for automatic control`);
            
            // Build simplified datapoint list for AI analysis
            const availableDatapoints = changeableDatapoints.map(result => ({
                id: result.payload.datapoint_id,
                description: result.payload.description,
                location: result.payload.location,
                dataType: result.payload.dataType,
                currentValue: result.payload.value,
                customConfig: {
                    booleanTrueValue: result.payload.booleanTrueValue,
                    booleanFalseValue: result.payload.booleanFalseValue,
                    allowAutoChange: result.payload.allowAutoChange
                }
            }));
            
            // Use AI to analyze potential changes (focused prompt for direct control)
            const changes = await this._analyzeForDirectDatapointChanges(message, availableDatapoints);
            
            if (changes.length === 0) {
                this.log.debug(`[ToolServer] No datapoint changes detected in message: "${message}"`);
                return [];
            }
            
            // Execute changes immediately (like other adapters)
            const appliedChanges = [];
            for (const change of changes) {
                try {
                    // Direct setState through DatapointController
                    const result = await this._executeDirectDatapointChange(change, modelId);
                    if (result.success) {
                        appliedChanges.push(result);
                        this.log.info(`[AutoChange] ${change.datapointId} → ${result.convertedValue} (${change.reasoning})`);
                    } else {
                        this.log.warn(`[AutoChange] Failed to change ${change.datapointId}: ${result.error}`);
                    }
                } catch (error) {
                    this.log.error(`[AutoChange] Error changing ${change.datapointId}: ${error.message}`);
                }
            }
            
            return appliedChanges;
            
        } catch (error) {
            this.log.error(`[ToolServer] Automatic datapoint control error: ${error.message}`);
            return [];
        }
    }

    /**
     * Analyze message for direct datapoint changes (simplified approach)
     * @param {string} message - User message
     * @param {Array} availableDatapoints - Available datapoints
     * @returns {Promise<Array>} Potential changes
     */
    async _analyzeForDirectDatapointChanges(message, availableDatapoints) {
        try {
            // Build focused prompt for datapoint analysis
            const prompt = this._buildDirectControlPrompt(message, availableDatapoints);
            
            // Use AI to analyze (low temperature for consistency)
            const analysisResponse = await this._generateChatResponse(this.chatModel, [
                { role: "user", content: prompt }
            ], 0.2, 512); // Low temp, short response
            
            this.log.debug(`[ToolServer] Direct control analysis: ${analysisResponse}`);
            
            // Parse response to extract changes
            return this._parseDirectControlResponse(analysisResponse, availableDatapoints);
            
        } catch (error) {
            this.log.error(`[ToolServer] Direct control analysis error: ${error.message}`);
            return [];
        }
    }

    /**
     * Build focused prompt for direct datapoint control
     * @param {string} message - User message
     * @param {Array} availableDatapoints - Available datapoints
     * @returns {string} Analysis prompt
     */
    _buildDirectControlPrompt(message, availableDatapoints) {
        const datapointList = availableDatapoints.map(dp => {
            let typeInfo = `Type: ${dp.dataType}`;
            if (dp.dataType === 'boolean' && dp.customConfig) {
                typeInfo += `, True: "${dp.customConfig.booleanTrueValue || 'true'}", False: "${dp.customConfig.booleanFalseValue || 'false'}"`;
            }
            return `- ${dp.id}: ${dp.description} (${typeInfo}, Current: ${dp.currentValue})${dp.location ? ` [${dp.location}]` : ''}`;
        }).join('\n');

        return `Analysiere diese Nachricht und bestimme welche Datenpunkte geändert werden sollen.

Verfügbare Datenpunkte:
${datapointList}

Nachricht: "${message}"

Antworte nur mit JSON (keine Erklärung):
{
  "changes": [
    {
      "datapointId": "exact_id",
      "value": "new_value",
      "reasoning": "kurze Begründung"
    }
  ]
}

Intelligente Konvertierung:
- Deutsch: "anwesend"/"da"/"zuhause" → true, "weg"/"abwesend"/"nicht da" → false
- Zahlen: "20 Grad"/"zwanzig" → 20
- Verwende nur IDs aus der Liste oben`;
    }

    /**
     * Parse direct control response from AI
     * @param {string} response - AI response
     * @param {Array} availableDatapoints - Available datapoints for validation
     * @returns {Array} Parsed changes
     */
    _parseDirectControlResponse(response, availableDatapoints) {
        try {
            // Clean response (remove markdown, etc.)
            let jsonStr = response.trim();
            if (jsonStr.includes('```json')) {
                jsonStr = jsonStr.split('```json')[1].split('```')[0].trim();
            } else if (jsonStr.includes('```')) {
                jsonStr = jsonStr.split('```')[1].split('```')[0].trim();
            }
            
            // Extract JSON object
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            }
            
            const parsed = JSON.parse(jsonStr);
            
            if (!parsed.changes || !Array.isArray(parsed.changes)) {
                return [];
            }
            
            // Validate changes
            const validChanges = [];
            for (const change of parsed.changes) {
                if (!change.datapointId || change.value === undefined) {
                    continue;
                }
                
                // Verify datapoint exists
                const datapoint = availableDatapoints.find(dp => dp.id === change.datapointId);
                if (!datapoint) {
                    this.log.warn(`[ToolServer] Unknown datapoint in AI response: ${change.datapointId}`);
                    continue;
                }
                
                validChanges.push({
                    datapointId: change.datapointId,
                    value: change.value,
                    reasoning: change.reasoning || 'AI detected change',
                    datapoint: datapoint // Include datapoint info for conversion
                });
            }
            
            return validChanges;
            
        } catch (error) {
            this.log.error(`[ToolServer] Failed to parse direct control response: ${error.message}`);
            return [];
        }
    }

    /**
     * Execute direct datapoint change (like other adapters)
     * @param {object} change - Change to execute
     * @param {string} modelId - Model identifier
     * @returns {Promise<object>} Execution result
     */
    async _executeDirectDatapointChange(change, modelId) {
        try {
            // Use DatapointController for intelligent value conversion and setState
            const result = await this.datapointController.handleSetDatapointValue({
                datapointId: change.datapointId,
                value: change.value
            }, modelId);
            
            // Add reasoning to result
            result.reasoning = change.reasoning;
            
            return result;
            
        } catch (error) {
            return {
                success: false,
                datapointId: change.datapointId,
                error: error.message,
                reasoning: change.reasoning
            };
        }
    }

    /**
     * Process RAG query with vector search and LLM generation
     * @param {string} query - User query
     * @param {number} maxResults - Maximum context results
     * @returns {Promise<object>} RAG response
     */
    async _processRAGQuery(query, maxResults = 5) {
        try {
            // Step 1: Generate embedding for user query
            const queryEmbedding = await this._generateEmbedding(query);
            
            // Step 2: Search for similar datapoints in Qdrant
            const contextResults = await this._searchSimilarDatapoints(queryEmbedding, maxResults);
            
            // Step 3: Build context from search results
            const context = this._buildContext(contextResults);
            
            // Step 4: Generate answer using LLM with context
            const answer = await this._generateContextualAnswer(query, context);
            
            return {
                answer: answer,
                context_used: contextResults.map(result => ({
                    datapoint_id: result.payload.datapoint_id,
                    description: result.payload.description,
                    value: result.payload.value,
                    timestamp: result.payload.timestamp,
                    score: result.score
                }))
            };
            
        } catch (error) {
            this.log.error(`[ToolServer] RAG processing error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Process natural language input to automatically control datapoints
     * Uses AI to interpret the message and determine appropriate datapoint changes
     * @param {string} message - Natural language message
     * @param {string} modelId - AI model identifier for logging
     * @returns {Promise<object>} Control result
     */
    async _processNaturalLanguageDatapointControl(message, modelId) {
        try {
            if (!this.datapointController) {
                throw new Error('DatapointController not available');
            }

            this.log.info(`[ToolServer] Processing natural language control: "${message}" from model: ${modelId}`);

            // Step 1: Get RAG context to understand available datapoints
            let availableDatapoints = [];
            if (this.qdrantClient) {
                try {
                    const queryEmbedding = await this._generateEmbedding(message);
                    const contextResults = await this._searchSimilarDatapoints(queryEmbedding, 10);
                    availableDatapoints = contextResults.map(result => ({
                        id: result.payload.datapoint_id,
                        description: result.payload.description,
                        location: result.payload.location,
                        dataType: result.payload.dataType,
                        currentValue: result.payload.value,
                        score: result.score
                    }));
                    
                    this.log.debug(`[ToolServer] Found ${availableDatapoints.length} relevant datapoints for context`);
                } catch (ragError) {
                    this.log.warn(`[ToolServer] RAG context retrieval failed: ${ragError.message}`);
                }
            }

            // Step 2: Use AI to analyze the message and determine which datapoints to change
            const analysisPrompt = this._buildDatapointAnalysisPrompt(message, availableDatapoints);
            const analysisResponse = await this._generateChatResponse(this.chatModel, [
                {
                    role: "user",
                    content: analysisPrompt
                }
            ], 0.3, 1024); // Low temperature for consistent results

            this.log.debug(`[ToolServer] AI analysis response: ${analysisResponse}`);

            // Step 3: Parse AI response to extract datapoint changes
            const changes = this._parseDatapointChanges(analysisResponse, availableDatapoints);
            
            if (changes.length === 0) {
                return {
                    success: true,
                    message: "No datapoint changes detected in the message",
                    changes: [],
                    analysis: analysisResponse
                };
            }

            // Step 4: Execute the changes using DatapointController
            const results = [];
            for (const change of changes) {
                try {
                    const result = await this.datapointController.handleSetDatapointValue({
                        datapointId: change.datapointId,
                        value: change.value
                    }, modelId);
                    
                    results.push({
                        ...result,
                        reasoning: change.reasoning
                    });
                    
                    this.log.info(`[ToolServer] Successfully changed ${change.datapointId} to ${change.value} - ${change.reasoning}`);
                    
                } catch (error) {
                    this.log.error(`[ToolServer] Failed to change ${change.datapointId}: ${error.message}`);
                    results.push({
                        success: false,
                        datapointId: change.datapointId,
                        error: error.message,
                        reasoning: change.reasoning
                    });
                }
            }

            return {
                success: results.some(r => r.success),
                message: `Processed ${results.length} datapoint changes`,
                changes: results,
                originalMessage: message,
                analysis: analysisResponse
            };

        } catch (error) {
            this.log.error(`[ToolServer] Natural language control processing error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Build prompt for AI analysis of natural language datapoint control
     * @param {string} message - User message
     * @param {Array} availableDatapoints - Available datapoints from RAG
     * @returns {string} Analysis prompt
     */
    _buildDatapointAnalysisPrompt(message, availableDatapoints) {
        const datapointList = availableDatapoints.length > 0 
            ? availableDatapoints.map(dp => 
                `- ${dp.id}: ${dp.description} (${dp.dataType}, current: ${dp.currentValue}) ${dp.location ? `[${dp.location}]` : ''}`
              ).join('\n')
            : 'No specific datapoints found in context.';

        return `Du bist ein intelligenter Home Automation Assistent. Analysiere die folgende Nachricht und bestimme, welche ioBroker Datenpunkte geändert werden sollen.

Verfügbare Datenpunkte:
${datapointList}

Benutzer Nachricht: "${message}"

Analysiere die Nachricht und antworte im folgenden JSON Format (nur gültiges JSON, keine zusätzlichen Erklärungen):

{
  "detected_changes": [
    {
      "datapointId": "exact_datapoint_id",
      "value": "new_value",
      "reasoning": "Warum diese Änderung vorgenommen wird"
    }
  ]
}

Regeln:
1. Verwende nur Datenpunkt-IDs aus der obigen Liste
2. Konvertiere natürliche Sprache intelligent in passende Werte:
   - "anwesend", "da", "zuhause" → true (für Boolean)
   - "weg", "nicht da", "abwesend" → false (für Boolean)
   - "20 Grad", "zwanzig" → 20 (für Number)
   - Andere Texteingaben → String
3. Wenn kein passender Datenpunkt gefunden wird, gib eine leere Liste zurück
4. Antworte nur mit gültigem JSON`;
    }

    /**
     * Parse AI response to extract datapoint changes
     * @param {string} response - AI response
     * @param {Array} availableDatapoints - Available datapoints for validation
     * @returns {Array} Parsed changes
     */
    _parseDatapointChanges(response, availableDatapoints) {
        try {
            // Clean up response - extract JSON from potential markdown or extra text
            let jsonStr = response.trim();
            
            // Remove markdown code blocks if present
            if (jsonStr.includes('```json')) {
                jsonStr = jsonStr.split('```json')[1].split('```')[0].trim();
            } else if (jsonStr.includes('```')) {
                jsonStr = jsonStr.split('```')[1].split('```')[0].trim();
            }
            
            // Try to find JSON object in the response
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            }
            
            const parsed = JSON.parse(jsonStr);
            
            if (!parsed.detected_changes || !Array.isArray(parsed.detected_changes)) {
                this.log.warn(`[ToolServer] Invalid AI response format: missing detected_changes array`);
                return [];
            }
            
            // Validate and filter changes
            const validChanges = [];
            for (const change of parsed.detected_changes) {
                if (!change.datapointId || change.value === undefined) {
                    this.log.warn(`[ToolServer] Skipping invalid change: missing datapointId or value`);
                    continue;
                }
                
                // Verify datapoint exists in available list (if we have context)
                if (availableDatapoints.length > 0) {
                    const exists = availableDatapoints.some(dp => dp.id === change.datapointId);
                    if (!exists) {
                        this.log.warn(`[ToolServer] Skipping change for unknown datapoint: ${change.datapointId}`);
                        continue;
                    }
                }
                
                validChanges.push({
                    datapointId: change.datapointId,
                    value: change.value,
                    reasoning: change.reasoning || 'AI detected change'
                });
            }
            
            this.log.debug(`[ToolServer] Parsed ${validChanges.length} valid changes from AI response`);
            return validChanges;
            
        } catch (error) {
            this.log.error(`[ToolServer] Failed to parse AI response: ${error.message}`);
            this.log.debug(`[ToolServer] Problematic response: ${response}`);
            return [];
        }
    }

    /**
     * Generate embedding for text using OpenWebUI/Ollama
     * @param {string} text - Text to embed
     * @returns {Promise<Array>} Embedding vector
     */
    async _generateEmbedding(text) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.apiKey) {
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            }
            
            const response = await axios.post(`${this.openWebUIUrl}/ollama/api/embed`, {
                model: this.embeddingModel,
                input: text
            }, { headers, timeout: 30000 });
            
            if (!response.data.embeddings?.[0]) {
                throw new Error('No embedding returned from API');
            }
            
            return response.data.embeddings[0];
            
        } catch (error) {
            this.log.error(`[ToolServer] Embedding generation error: ${error.message}`);
            throw new Error(`Failed to generate embedding: ${error.message}`);
        }
    }

    /**
     * Search for similar datapoints in Qdrant
     * @param {Array} queryEmbedding - Query embedding vector
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>} Similar datapoints
     */
    async _searchSimilarDatapoints(queryEmbedding, limit = 5) {
        try {
            if (!this.qdrantClient) {
                throw new Error('Qdrant client not initialized');
            }
            
            const searchResult = await this.qdrantClient.search(this.collectionName, {
                vector: queryEmbedding,
                limit: limit,
                with_payload: true,
                score_threshold: 0.3 // Only include reasonably similar results
            });
            
            this.log.debug(`[ToolServer] Found ${searchResult.length} similar datapoints`);
            return searchResult;
            
        } catch (error) {
            this.log.error(`[ToolServer] Qdrant search error: ${error.message}`);
            throw new Error(`Vector search failed: ${error.message}`);
        }
    }

    /**
     * Build context text from search results
     * @param {Array} results - Qdrant search results
     * @returns {string} Formatted context
     */
    _buildContext(results) {
        if (!results.length) {
            return "No relevant datapoint information found.";
        }
        
        const contextItems = results.map(result => {
            const payload = result.payload;
            const timestamp = new Date(payload.timestamp).toLocaleString();
            
            return `${payload.description}: ${payload.value} (${payload.location || 'Unknown location'}) - ${timestamp}`;
        });
        
        return `Relevant smart home information:\n${contextItems.join('\n')}`;
    }

    /**
     * Generate contextual answer using LLM
     * @param {string} query - Original user query
     * @param {string} context - Relevant context information
     * @returns {Promise<string>} Generated answer
     */
    async _generateContextualAnswer(query, context) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.apiKey) {
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            }
            
            const systemPrompt = `Du bist ein Smart Home Assistent mit Zugriff auf ioBroker Datenpunkt-Informationen. Beantworte Benutzerfragen basierend auf dem bereitgestellten Kontext. Sei präzise und hilfreich. Falls der Kontext keine relevanten Informationen enthält, sage das klar.`;
            
            const userPrompt = `Kontext:\n${context}\n\nFrage: ${query}\n\nAntwort:`;
            
            // Try OpenWebUI chat completions first, then fallback to Ollama direct
            let response;
            try {
                response = await axios.post(`${this.openWebUIUrl}/api/chat/completions`, {
                    model: this.chatModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    stream: false,
                    temperature: 0.3,
                    max_tokens: 1024
                }, { headers, timeout: 60000 });
            } catch (openWebUIError) {
                this.log.debug(`[ToolServer] OpenWebUI chat failed: ${openWebUIError.message}, trying Ollama direct...`);
                
                // Fallback to direct Ollama API
                const ollamaUrl = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;
                response = await axios.post(`${ollamaUrl}/api/generate`, {
                    model: this.chatModel,
                    prompt: `${systemPrompt}\n\n${userPrompt}`,
                    stream: false,
                    options: {
                        temperature: 0.3,
                        num_predict: 1024
                    }
                }, { 
                    headers: { 'Content-Type': 'application/json' }, 
                    timeout: 60000 
                });
                
                if (response.data?.response) {
                    return response.data.response.trim();
                } else {
                    throw new Error('No response from Ollama direct API');
                }
            }
            
            if (response.data?.choices?.[0]?.message?.content) {
                return response.data.choices[0].message.content.trim();
            } else {
                throw new Error('No response from chat model');
            }
            
        } catch (error) {
            this.log.error(`[ToolServer] Chat generation error: ${error.message}`);
            
            // Return context-based fallback answer
            if (context && !context.includes("No relevant datapoint information found")) {
                return `Basierend auf den verfügbaren Smart Home Daten: ${context}`;
            } else {
                return `Es tut mir leid, ich konnte keine relevanten Informationen zu Ihrer Frage "${query}" finden.`;
            }
        }
    }

    /**
     * Initialize Qdrant connection
     * @returns {Promise<boolean>} Success status
     */
    async _initializeQdrant() {
        try {
            const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
            this.qdrantClient = new QdrantClient({ url: qdrantUrl });
            
            // Test connection
            await this.qdrantClient.getCollections();
            this.log.info(`[ToolServer] Qdrant connection established: ${qdrantUrl}`);
            
            return true;
            
        } catch (error) {
            this.log.error(`[ToolServer] Qdrant connection failed: ${error.message}`);
            this.qdrantClient = null;
            return false;
        }
    }

    /**
     * Find an available port starting from the configured port
     * @param {number} startPort - Starting port to try
     * @returns {Promise<number>} Available port
     */
    async _findAvailablePort(startPort) {
        const net = require('net');
        
        const checkPort = (port) => {
            return new Promise((resolve) => {
                const server = net.createServer();
                server.listen(port, this.host, () => {
                    server.close(() => resolve(port));
                });
                server.on('error', () => resolve(null));
            });
        };
        
        // Check if our own service is already running on the port
        const checkOwnService = async (port) => {
            try {
                const axios = require('axios');
                const response = await axios.get(`http://localhost:${port}/health`, { timeout: 1000 });
                if (response.data?.service === 'ioBroker Ollama Tool Server') {
                    this.log.warn(`[ToolServer] Another ioBroker Tool Server already running on port ${port}`);
                    return true;
                }
            } catch (error) {
                // Port not responding or different service
            }
            return false;
        };
        
        // Try the configured port first
        if (await checkOwnService(startPort)) {
            throw new Error(`ioBroker Tool Server already running on port ${startPort}. Avoiding duplicate instances.`);
        }
        
        let availablePort = await checkPort(startPort);
        if (availablePort) {
            return availablePort;
        }
        
        // If configured port is busy, try next 5 ports (reduced from 10)
        for (let i = 1; i <= 5; i++) {
            const tryPort = startPort + i;
            
            if (await checkOwnService(tryPort)) {
                continue; // Skip if our service is already running
            }
            
            availablePort = await checkPort(tryPort);
            if (availablePort) {
                this.log.info(`[ToolServer] Port ${startPort} was busy, using port ${tryPort} instead`);
                return tryPort;
            }
        }
        
        throw new Error(`No available port found in range ${startPort}-${startPort + 5}`);
    }

    /**
     * Start the tool server
     * @returns {Promise<boolean>} Success status
     */
    async start() {
        try {
            // Check if another instance is already running
            if (await this.controller.isRunning()) {
                const runningInstance = this.controller.getRunningInstance();
                this.log.warn(`[ToolServer] Another Tool Server is already running on port ${runningInstance?.port || 'unknown'}`);
                this.log.info('[ToolServer] Skipping startup to avoid conflicts');
                return false;
            }
            
            // Initialize Qdrant connection
            const qdrantConnected = await this._initializeQdrant();
            if (!qdrantConnected) {
                this.log.warn('[ToolServer] Starting without Qdrant connection - RAG queries will fail');
            }
            
            // Find available port
            const availablePort = await this._findAvailablePort(this.port);
            this.port = availablePort;
            
            // Try to start server
            return new Promise((resolve, reject) => {
                const server = this.app.listen(this.port, this.host, (error) => {
                    if (error) {
                        this.log.error(`[ToolServer] Failed to start server: ${error.message}`);
                        reject(error);
                    } else {
                        this.server = server;
                        
                        // Create lock file to prevent multiple instances
                        this.controller.createLock(this.port);
                        
                        this.log.info(`[ToolServer] Started on http://${this.host}:${this.port}`);
                        this.log.info(`[ToolServer] OpenAPI spec: http://${this.host}:${this.port}/openapi.json`);
                        this.log.info(`[ToolServer] RAG endpoint: http://${this.host}:${this.port}/tools/iobroker-rag`);
                        resolve(true);
                    }
                });
                
                // Handle server errors
                server.on('error', (error) => {
                    this.log.error(`[ToolServer] Server error: ${error.message}`);
                    reject(error);
                });
            });
            
        } catch (error) {
            this.log.error(`[ToolServer] Startup error: ${error.message}`);
            return false;
        }
    }

    /**
     * Stop the tool server
     * @returns {Promise<void>}
     */
    async stop() {
        try {
            if (this.server) {
                return new Promise((resolve) => {
                    this.server.close(() => {
                        this.log.info('[ToolServer] Server stopped');
                        this.server = null;
                        
                        // Clean up lock file
                        this.controller.cleanup();
                        
                        resolve();
                    });
                });
            } else {
                // Clean up lock file even if server wasn't running
                this.controller.cleanup();
            }
        } catch (error) {
            this.log.error(`[ToolServer] Error stopping server: ${error.message}`);
            this.controller.cleanup();
        }
    }

    /**
     * Check if server is running
     * @returns {boolean} Running status
     */
    isRunning() {
        return this.server !== null;
    }
}

module.exports = ToolServer;
