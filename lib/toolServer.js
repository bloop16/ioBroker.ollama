"use strict";

const express = require("express");
const cors = require("cors");
const http = require("http");
const net = require("net");
const { QdrantClient } = require("@qdrant/qdrant-js");
const axios = require("axios");
const ToolServerController = require("./toolServerController");
const AdaptiveIntentDetector = require("./adaptiveIntentDetector");
const DatapointLearning = require("./datapointLearning");

/**
 * OpenWebUI Tool Server for ioBroker Qdrant Vector Database Integration
 * Provides RAG (Retrieval Augmented Generation) functionality as OpenAPI tool
 */
class ToolServer {
    /**
     * @param {object} config - Adapter configuration
     * @param {object} log - Logger instance
     * @p                    // Step 3: Learning - track this control action
                    if (this.learningSystem) {
                        this.learningSystem.recordDatapointActions(currentDatapoints);
                        
                        // Get suggestions for related datapoints
                        const suggestions = this.learningSystem.getSuggestedPartners(intent.datapoint, 2);
                        
                        // Check if this creates or updates a scene
                        if (intent.isScene && intent.sceneName) {
                            this.learningSystem.createSceneFromAssociations(intent.sceneName, currentDatapoints);
                        }nabledDatapoints - Set of enabled datapoints for context
     * @param {object} datapointController - DatapointController for function calling
     * @param {object} adapter - ioBroker adapter instance for learning system
     */
    constructor(config, log, enabledDatapoints, datapointController, adapter = null) {
        this.config = config;
        this.log = log;
        this.enabledDatapoints = enabledDatapoints;
        this.datapointController = datapointController;
        this.adapter = adapter;
        
        this.app = express();
        this.server = null;
        this.qdrantClient = null;
        this.controller = new ToolServerController();
        this.isRunning = false;
        
        // Initialize new components for Ansatz D
        this.intentDetector = new AdaptiveIntentDetector(); // Will be upgraded with Ollama client later
        this.learningSystem = adapter ? new DatapointLearning(adapter, log) : null;
        
        // Server configuration
        this.host = config.toolServerHost || "0.0.0.0";
        this.port = config.toolServerPort || 9099;
        this.maxPortAttempts = 10;
        this.collectionName = config.vectorDbCollection || "iobroker_datapoints";
        
        // OpenWebUI/Ollama configuration
        this.openWebUIUrl = `http://${config.openWebUIIp}:${config.openWebUIPort}`;
        this.ollamaUrl = `http://${config.ollamaIp}:${config.ollamaPort}`;
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
        this.app.use(cors({
            origin: true,
            credentials: true
        }));
        this.app.use(express.json({ limit: "50mb" }));
        this.app.use(express.urlencoded({ extended: true }));
    }

    /**
     * Setup all routes for the ToolServer
     */
    _setupRoutes() {
        this.log.debug("[ToolServer] Setting up routes...");
        
        // Health check endpoint
        this.app.get("/health", (req, res) => {
            res.json({ 
                status: "ok", 
                timestamp: new Date().toISOString(),
                service: "ioBroker ToolServer"
            });
        });
        this.log.debug("[ToolServer] Registered GET /health");

        // OpenAPI specification endpoint for OpenWebUI
        this.app.get("/openapi.json", (req, res) => {
            res.json(this._getOpenAPISpec());
        });
        this.log.debug("[ToolServer] Registered GET /openapi.json");

        // Main RAG tool endpoint for OpenWebUI
        this.app.post("/tools/iobroker-rag", async (req, res) => {
            try {
                await this._handleRAGRequest(req, res);
            } catch (error) {
                this.log.error(`[ToolServer] Error in RAG endpoint: ${error.message}`);
                res.status(500).json({ error: "Internal server error" });
            }
        });
        this.log.debug("[ToolServer] Registered POST /tools/iobroker-rag");

        // Chat completions endpoint for OllamaClient
        this.app.post("/chat/completions", async (req, res) => {
            try {
                const { model, messages, temperature = 0.7, max_tokens = 2048, use_rag = true } = req.body;
                
                if (!model || !messages || !Array.isArray(messages)) {
                    return res.status(400).json({ error: "model and messages are required" });
                }

                const userMessage = messages[messages.length - 1];
                if (!userMessage || !userMessage.content) {
                    return res.status(400).json({ error: "Valid user message required" });
                }

                this.log.debug(`[ToolServer] Processing chat completion for model: ${model}`);
                
                const result = await this._processCompleteChat({
                    model,
                    messages,
                    temperature,
                    max_tokens,
                    use_rag
                });
                
                res.json(result);
                
            } catch (error) {
                this.log.error(`[ToolServer] Chat completion error: ${error.message}`);
                res.status(500).json({ error: "Failed to process chat completion" });
            }
        });
        this.log.debug("[ToolServer] Registered POST /chat/completions");

        // Tools list endpoint for OpenWebUI discovery
        this.app.get("/tools", (req, res) => {
            try {
                const tools = this.datapointController ? this.datapointController.getFunctionDefinitions() : [];
                res.json(tools);
            } catch (error) {
                this.log.error(`[ToolServer] Error getting tools: ${error.message}`);
                res.status(500).json({ error: "Failed to get tools" });
            }
        });
        this.log.debug("[ToolServer] Registered GET /tools");

        // Ansatz D: AI Intent-based Control endpoint
        this.app.post("/tools/ai-control", async (req, res) => {
            try {
                await this._handleAIControlRequest(req, res);
            } catch (error) {
                this.log.error(`[ToolServer] Error in AI control endpoint: ${error.message}`);
                res.status(500).json({ error: "Internal server error" });
            }
        });
        this.log.debug("[ToolServer] Registered POST /tools/ai-control");

        // Debug endpoints for AI control system
        this.app.post("/debug/test-intent", async (req, res) => {
            try {
                await this._handleTestIntent(req, res);
            } catch (error) {
                this.log.error(`[ToolServer] Error in test-intent endpoint: ${error.message}`);
                res.status(500).json({ error: "Internal server error" });
            }
        });
        this.log.debug("[ToolServer] Registered POST /debug/test-intent");

        this.app.get("/debug/ai-control-status", async (req, res) => {
            try {
                await this._handleAIControlDebug(req, res);
            } catch (error) {
                this.log.error(`[ToolServer] Error in ai-control-status endpoint: ${error.message}`);
                res.status(500).json({ error: "Internal server error" });
            }
        });
        this.log.debug("[ToolServer] Registered GET /debug/ai-control-status");

        this.app.post("/ai-control/execute", async (req, res) => {
            try {
                await this._handleDirectAIControl(req, res);
            } catch (error) {
                this.log.error(`[ToolServer] Error in direct AI control endpoint: ${error.message}`);
                res.status(500).json({ error: "Internal server error" });
            }
        });
        this.log.debug("[ToolServer] Registered POST /ai-control/execute");

        // Learning system endpoints
        if (this.learningSystem) {
            this.app.get("/learning/suggestions/:datapointId", (req, res) => {
                try {
                    if (!this.learningSystem) {
                        return res.status(503).json({ error: "Learning system not available" });
                    }
                    const { datapointId } = req.params;
                    const { minFrequency = 1 } = req.query;
                    const suggestions = this.learningSystem.getSuggestedPartners(datapointId, parseInt(minFrequency));
                    res.json(suggestions);
                } catch (error) {
                    this.log.error(`[ToolServer] Error getting suggestions: ${error.message}`);
                    res.status(500).json({ error: "Failed to get suggestions" });
                }
            });

            this.app.get("/learning/scenes", (req, res) => {
                try {
                    if (!this.learningSystem) {
                        return res.status(503).json({ error: "Learning system not available" });
                    }
                    const scenes = this.learningSystem.getLearnedScenes();
                    res.json(scenes);
                } catch (error) {
                    this.log.error(`[ToolServer] Error getting scenes: ${error.message}`);
                    res.status(500).json({ error: "Failed to get scenes" });
                }
            });

            this.app.post("/learning/scenes/:sceneName", (req, res) => {
                try {
                    if (!this.learningSystem) {
                        return res.status(503).json({ error: "Learning system not available" });
                    }
                    const { sceneName } = req.params;
                    // For now, just return the scene info - execution would need more implementation
                    const scenes = this.learningSystem.getLearnedScenes();
                    const scene = scenes.find(s => s.name === sceneName);
                    if (!scene) {
                        return res.status(404).json({ error: "Scene not found" });
                    }
                    res.json({ message: "Scene execution would be implemented here", scene });
                } catch (error) {
                    this.log.error(`[ToolServer] Error executing scene: ${error.message}`);
                    res.status(500).json({ error: "Failed to execute scene" });
                }
            });
            
            this.log.debug("[ToolServer] Registered learning system endpoints");
        }
        
        this.log.debug("[ToolServer] All routes registered successfully");
    }

    /**
     * Get OpenAPI specification for OpenWebUI
     */
    _getOpenAPISpec() {
        return {
            openapi: "3.0.0",
            info: {
                title: "ioBroker RAG Tool",
                description: "Query ioBroker datapoints using RAG (Retrieval Augmented Generation)",
                version: "1.0.0"
            },
            servers: [
                {
                    url: `http://${this.host}:${this.port}`
                }
            ],
            paths: {
                "/tools/iobroker-rag": {
                    post: {
                        summary: "Query ioBroker datapoints",
                        description: "Use RAG to query ioBroker datapoints and get context-aware responses",
                        operationId: "query_iobroker_datapoints",
                        requestBody: {
                            required: true,
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            query: {
                                                type: "string",
                                                description: "The query to search for in ioBroker datapoints"
                                            }
                                        },
                                        required: ["query"]
                                    }
                                }
                            }
                        },
                        responses: {
                            "200": {
                                description: "Successful response",
                                content: {
                                    "application/json": {
                                        schema: {
                                            type: "object",
                                            properties: {
                                                answer: {
                                                    type: "string",
                                                    description: "The RAG response with datapoint information"
                                                },
                                                context_used: {
                                                    type: "array",
                                                    description: "List of datapoints used for context"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }

    /**
     * Handle RAG requests from OpenWebUI
     */
    async _handleRAGRequest(req, res) {
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
    }

    /**
     * Process complete chat with RAG integration
     */
    async _processCompleteChat(chatRequest) {
        const { model, messages, temperature = 0.7, max_tokens = 2048, use_rag = true } = chatRequest;
        
        try {
            const userMessage = messages[messages.length - 1];
            const userQuery = userMessage.content;
            
            // Step 1: Check for control intent first (Ansatz D integration)
            if (this.intentDetector) {
                const intent = await this.intentDetector.detectControlIntent(userQuery);
                this.log.debug(`[ToolServer] Intent analysis:`, intent);
                
                if (intent.isControl && intent.confidence > 0.5) {
                    // This is a control command - try to execute it
                    try {
                        this.log.debug(`[ToolServer] Processing control intent with value: ${intent.value} (type: ${typeof intent.value})`);
                        const controlResult = await this._processControlIntent(intent, userQuery);
                        this.log.debug(`[ToolServer] Control result:`, controlResult);
                        
                        if (controlResult.success) {
                            // Return successful control response
                            return {
                                id: `chatcmpl-${Date.now()}`,
                                object: "chat.completion",
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{
                                    index: 0,
                                    message: {
                                        role: "assistant",
                                        content: controlResult.message
                                    },
                                    finish_reason: "stop"
                                }],
                                usage: {
                                    prompt_tokens: 0,
                                    completion_tokens: 0,
                                    total_tokens: 0
                                },
                                control_result: controlResult
                            };
                        }
                        // If control failed, fall through to RAG
                        this.log.warn(`[ToolServer] Control intent failed, falling back to RAG. Error: ${controlResult.error}`);
                    } catch (controlError) {
                        this.log.error(`[ToolServer] Control processing error: ${controlError.message}`);
                        this.log.error(`[ToolServer] Control error stack:`, controlError.stack);
                        // Fall through to RAG
                    }
                } else {
                    this.log.debug(`[ToolServer] Intent not recognized as control (isControl: ${intent.isControl}, confidence: ${intent.confidence})`);
                }
            }
            
            let finalMessages = [...messages];
            let contextUsed = [];
            
            // Apply RAG if enabled and vector database is available
            if (use_rag && this.qdrantClient) {
                try {
                    this.log.debug(`[ToolServer] Applying RAG for query: "${userQuery}"`);
                    
                    // Generate embedding and search for relevant context
                    const queryEmbedding = await this._generateEmbedding(userQuery);
                    const contextResults = await this._searchSimilarDatapoints(queryEmbedding, 5);
                    
                    if (contextResults.length > 0) {
                        const context = this._buildContext(contextResults);
                        
                        // Enhance the user message with context
                        const enhancedContent = `Context from ioBroker datapoints:\n${context}\n\nUser query: ${userQuery}`;
                        
                        // Replace the last user message with enhanced version
                        finalMessages[finalMessages.length - 1] = {
                            ...userMessage,
                            content: enhancedContent
                        };
                        
                        contextUsed = contextResults.slice(0, 5).map(result => {
                            if (!result.payload) return null;
                            return {
                                datapoint_id: result.payload.id,
                                description: result.payload.description,
                                value: result.payload.value,
                                timestamp: result.payload.timestamp,
                                score: result.score
                            };
                        }).filter(item => item !== null);
                        
                        this.log.debug(`[ToolServer] Enhanced query with ${contextResults.length} context items`);
                    }
                } catch (ragError) {
                    this.log.warn(`[ToolServer] RAG enhancement failed: ${ragError.message}`);
                    // Continue without RAG enhancement
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
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                rag_context: contextUsed
            };
            
        } catch (error) {
            this.log.error(`[ToolServer] Complete chat processing error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate chat response using OpenWebUI/Ollama
     */
    async _generateChatResponse(model, messages, temperature = 0.7, maxTokens = 2048) {
        try {
            const headers = this._buildHeaders();
            
            // Try OpenWebUI chat completions first
            try {
                const response = await axios.post(`${this.openWebUIUrl}/api/chat/completions`, {
                    model: model,
                    messages: messages,
                    temperature: temperature,
                    max_tokens: maxTokens
                }, {
                    headers: headers,
                    timeout: 60000
                });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return response.data.choices[0].message.content;
                }
            } catch (openWebUIError) {
                this.log.debug(`[ToolServer] OpenWebUI chat failed, trying Ollama direct: ${openWebUIError.message}`);
                
                // Fallback to direct Ollama using configured URL
                const lastMessage = messages[messages.length - 1];
                
                const response = await axios.post(`${this.ollamaUrl}/api/generate`, {
                    model: model,
                    prompt: lastMessage.content,
                    stream: false,
                    options: {
                        temperature: temperature,
                        num_predict: maxTokens
                    }
                }, { timeout: 60000 });
                
                if (response.data?.response) {
                    return response.data.response;
                }
            }
            
            return "I'm sorry, I couldn't generate a response at this time.";
            
        } catch (error) {
            this.log.error(`[ToolServer] Chat response generation failed: ${error.message}`);
            throw new Error(`Chat generation failed: ${error.message}`);
        }
    }

    /**
     * Process RAG query with vector search and LLM generation
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
                context_used: contextResults.map(result => {
                    if (!result.payload) return null;
                    return {
                        datapoint_id: result.payload.id,
                        description: result.payload.description,
                        value: result.payload.value,
                        timestamp: result.payload.timestamp,
                        score: result.score
                    };
                }).filter(item => item !== null)
            };
            
        } catch (error) {
            this.log.error(`[ToolServer] RAG processing error: ${error.message}`);
            return {
                answer: `Sorry, I encountered an error while searching for information: ${error.message}`,
                context_used: []
            };
        }
    }

    /**
     * Generate embedding for text using OpenWebUI/Ollama
     */
    async _generateEmbedding(text) {
        try {
            const headers = this._buildHeaders();
            
            const response = await axios.post(`${this.openWebUIUrl}/ollama/api/embed`, {
                model: this.embeddingModel,
                input: text
            }, { headers, timeout: 30000 });
            
            if (!response.data.embeddings?.[0]) {
                throw new Error('No embedding returned from API');
            }
            
            return response.data.embeddings[0];
        } catch (error) {
            this.log.error(`[ToolServer] Embedding generation failed: ${error.message}`);
            throw new Error(`Embedding generation failed: ${error.message}`);
        }
    }

    /**
     * Search for similar datapoints in Qdrant
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
                score_threshold: 0.3
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
     */
    _buildContext(results) {
        if (!results.length) {
            return "No relevant datapoint information found.";
        }
        
        // Sort results by timestamp (newest first) to prioritize recent data
        const sortedResults = [...results].sort((a, b) => {
            const timeA = new Date(a.payload.timestamp).getTime();
            const timeB = new Date(b.payload.timestamp).getTime();
            return timeB - timeA; // Newest first
        });
        
        const contextItems = sortedResults.map((result, index) => {
            const payload = result.payload;
            const timestamp = new Date(payload.timestamp).toLocaleString();
            const ageIndicator = index === 0 ? " (MOST RECENT)" : "";
            
            return `${payload.description}: ${payload.value} (${payload.location || 'Unknown location'}) - ${timestamp}${ageIndicator}`;
        });
        
        return `Relevant smart home information (sorted by recency):\n${contextItems.join('\n')}`;
    }

    /**
     * Generate contextual answer using LLM
     */
    async _generateContextualAnswer(query, context) {
        try {
            const systemPrompt = "You are a helpful smart home assistant. Use the provided context to answer questions about the smart home status. ALWAYS use the most recent data (marked as 'MOST RECENT') when available. Answer in the same language as the question.";
            const userPrompt = `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer (use the most recent data):`;
            
            // Try OpenWebUI chat completions first
            try {
                const response = await axios.post(`${this.openWebUIUrl}/api/chat/completions`, {
                    model: this.chatModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 500
                }, {
                    headers: this._buildHeaders(),
                    timeout: 30000
                });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return response.data.choices[0].message.content;
                }
            } catch (openWebUIError) {
                this.log.debug(`[ToolServer] OpenWebUI chat failed, trying Ollama direct: ${openWebUIError.message}`);
                
                // Fallback to direct Ollama using configured URL
                const response = await axios.post(`${this.ollamaUrl}/api/generate`, {
                    model: this.chatModel,
                    prompt: `${systemPrompt}\n\n${userPrompt}`,
                    stream: false
                }, { timeout: 30000 });
                
                if (response.data?.response) {
                    return response.data.response;
                }
            }
            
            return "I couldn't generate a response at this time.";
            
        } catch (error) {
            this.log.error(`[ToolServer] Answer generation failed: ${error.message}`);
            return `Based on the available information: ${context}`;
        }
    }

    /**
     * Build headers for API requests
     */
    _buildHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        return headers;
    }

    /**
     * Initialize Qdrant connection
     * @returns {Promise<boolean>} Success status
     */
    async _initializeQdrant() {
        try {
            if (!this.config.useVectorDb) {
                return false;
            }
            
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
     * Handle AI-based control requests (Ansatz D implementation)
     */
    async _handleAIControlRequest(req, res) {
        try {
            const { query, language = "auto" } = req.body;
            
            if (!query) {
                return res.status(400).json({ error: "Query is required" });
            }

            this.log.debug(`[ToolServer] Processing AI control request: ${query}`);

            // Step 1: Detect intent
            const intent = await this.intentDetector.detectControlIntent(query);
            this.log.debug(`[ToolServer] Detected intent:`, intent);

            // Step 2: If it's a control intent, process the action
            if (intent.isControl && intent.target && intent.action && this.datapointController) {
                try {
                    // Get current datapoint information for learning
                    const currentDatapoints = [];

                    // Execute the control action
                    let result;
                    if (intent.value !== undefined) {
                        result = await this.datapointController.setDatapointValue(intent.target, intent.value);
                        currentDatapoints.push({ id: intent.target, value: intent.value });
                        this.log.info(`[ToolServer] AI Control - Set ${intent.target} to ${intent.value}`);
                    } else {
                        return res.status(400).json({ 
                            error: "Unable to determine target value",
                            intent: intent 
                        });
                    }

                    // Step 3: Learning - track this control action
                    if (this.learningSystem) {
                        this.learningSystem.recordAction(intent.target, intent.value);
                        
                        // Get suggestions for related datapoints
                        const suggestions = this.learningSystem.getSuggestedPartners(intent.target, 2);
                        
                        // Check if this creates or updates a scene
                        if (intent.isScene && intent.sceneName) {
                            this.learningSystem.createSceneFromAssociations(intent.target, intent.sceneName);
                        }
                        
                        return res.json({
                            success: true,
                            action: "control",
                            datapoint: intent.target,
                            value: intent.value,
                            result: result,
                            suggestions: suggestions.length > 0 ? suggestions : undefined,
                            scene: intent.sceneName || undefined
                        });
                    }

                    return res.json({
                        success: true,
                        action: "control", 
                        datapoint: intent.datapoint,
                        value: intent.value,
                        result: result
                    });

                } catch (controlError) {
                    this.log.error(`[ToolServer] Control action failed: ${controlError.message}`);
                    return res.status(500).json({ 
                        error: "Control action failed", 
                        details: controlError.message,
                        intent: intent
                    });
                }
            }

            // Step 4: If it's an information request or control failed, use RAG
            try {
                const ragResult = await this._processRAGQuery(query, 5);
                return res.json({
                    success: true,
                    action: "information",
                    intent: intent,
                    response: ragResult.response,
                    context: ragResult.context
                });
            } catch (ragError) {
                this.log.error(`[ToolServer] RAG fallback failed: ${ragError.message}`);
                return res.status(500).json({ 
                    error: "Unable to process request", 
                    intent: intent 
                });
            }

        } catch (error) {
            this.log.error(`[ToolServer] AI control request processing failed: ${error.message}`);
            res.status(500).json({ error: "Internal server error" });
        }
    }

    /**
     * Process control intent and execute datapoint changes
     */
    async _processControlIntent(intent, originalQuery) {
        try {
            this.log.debug(`[ToolServer] Processing control intent:`, intent);
            
            // Try to find matching datapoint for the target
            const datapointId = await this._findBestMatchingDatapoint(intent.target);
            
            if (!datapointId) {
                return {
                    success: false,
                    error: `No matching datapoint found for "${intent.target}"`,
                    intent: intent
                };
            }
            
            // Check if datapoint allows automatic changes
            if (!this.datapointController || !this.datapointController.allowedDatapoints.has(datapointId)) {
                return {
                    success: false,
                    error: `Datapoint "${datapointId}" is not allowed for automatic changes`,
                    intent: intent
                };
            }
            
            // Execute the control action
            const result = await this.datapointController.setDatapointValue(datapointId, intent.value);
            
            if (result.success) {
                // Learning: Record this successful action
                if (this.learningSystem) {
                    this.learningSystem.recordDatapointActions([{
                        id: datapointId,
                        value: intent.value,
                        context: `AI control: ${originalQuery}`
                    }]);
                }
                
                const message = intent.language === 'de' ? 
                    `Erfolgreich: ${datapointId} wurde auf ${intent.value} gesetzt.` :
                    `Success: ${datapointId} has been set to ${intent.value}.`;
                
                return {
                    success: true,
                    message: message,
                    datapoint: datapointId,
                    value: intent.value,
                    result: result
                };
            } else {
                return {
                    success: false,
                    error: `Failed to set datapoint: ${result.error}`,
                    intent: intent
                };
            }
            
        } catch (error) {
            this.log.error(`[ToolServer] Control intent processing error: ${error.message}`);
            return {
                success: false,
                error: error.message,
                intent: intent
            };
        }
    }

    /**
     * Find the best matching datapoint for a target description
     */
    async _findBestMatchingDatapoint(target) {
        try {
            if (!this.enabledDatapoints || this.enabledDatapoints.size === 0) {
                return null;
            }
            
            const targetLower = target.toLowerCase();
            let bestMatch = null;
            let bestScore = 0;
            
            // Check all enabled datapoints for matches
            for (const datapointId of this.enabledDatapoints) {
                const score = this._calculateMatchScore(targetLower, datapointId);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = datapointId;
                }
            }
            
            // Return match only if score is above threshold
            return bestScore > 0.3 ? bestMatch : null;
            
        } catch (error) {
            this.log.error(`[ToolServer] Datapoint matching error: ${error.message}`);
            return null;
        }
    }

    /**
     * Calculate match score between target and datapoint ID
     */
    _calculateMatchScore(target, datapointId) {
        const normalizedTarget = target.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
        const normalizedDatapoint = datapointId.toLowerCase().replace(/[._]/g, ' ');
        
        const targetWords = normalizedTarget.split(/\s+/);
        const datapointWords = normalizedDatapoint.split(/\s+/);
        
        let score = 0;
        let matches = 0;
        
        // Enhanced matching for flexible datapoint types
        for (const targetWord of targetWords) {
            if (targetWord.length < 2) continue;
            
            for (const dpWord of datapointWords) {
                if (dpWord.includes(targetWord) || targetWord.includes(dpWord)) {
                    if (dpWord === targetWord) {
                        score += 2.0; // Exact match
                    } else if (dpWord.includes(targetWord) || targetWord.includes(dpWord)) {
                        score += 1.0; // Partial match
                    }
                    matches++;
                    break;
                }
            }
        }
        
        // Check for semantic translations - enhanced for presence/state
        const translations = {
            // German to English
            'temperatur': ['temperature', 'temp'],
            'wohnzimmer': ['livingroom', 'living', 'room'],
            'schlafzimmer': ['bedroom', 'bed'],
            'küche': ['kitchen'],
            'bad': ['bathroom', 'bath'],
            'licht': ['light', 'lamp'],
            'heizung': ['heating', 'heater'],
            // Presence/State keywords
            'martin': ['martin', 'user', 'person'],
            'anwesenheit': ['presence', 'home', 'away'],
            'zuhause': ['home', 'present'],
            'weg': ['away', 'absent'],
            'status': ['state', 'status'],
            'zustand': ['state', 'condition']
        };
        
        // Apply translation matching
        for (const targetWord of targetWords) {
            if (translations[targetWord]) {
                for (const translation of translations[targetWord]) {
                    for (const dpWord of datapointWords) {
                        if (dpWord.includes(translation) || translation.includes(dpWord)) {
                            score += 1.5; // Translation match bonus
                            matches++;
                        }
                    }
                }
            }
        }
        
        // Boost score for word count match
        if (matches > 0) {
            score += matches / targetWords.length;
        }
        
        return score;
    }

    /**
     * Find an available port starting from the configured port
     */
    async _findAvailablePort(startPort = this.port) {
        for (let port = startPort; port < startPort + this.maxPortAttempts; port++) {
            if (await this._isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error(`No available port found in range ${startPort}-${startPort + this.maxPortAttempts}`);
    }

    /**
     * Check if a port is available
     */
    _isPortAvailable(port) {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.listen(port, "localhost", () => {
                server.once("close", () => {
                    resolve(true);
                });
                server.close();
            });
            server.on("error", () => {
                resolve(false);
            });
        });
    }

    /**
     * Start the ToolServer
     */
    async start() {
        if (this.isRunning) {
            this.log.debug("[ToolServer] Already running");
            return true;
        }

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
                        this.isRunning = true;
                        
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
                    this.isRunning = false;
                    reject(error);
                });
            });

        } catch (error) {
            this.log.error(`[ToolServer] Failed to start: ${error.message}`);
            return false;
        }
    }

    /**
     * Stop the ToolServer
     * @returns {Promise<void>}
     */
    async stop() {
        try {
            if (this.server) {
                return new Promise((resolve) => {
                    this.server.close(() => {
                        this.log.info('[ToolServer] Server stopped');
                        this.server = null;
                        this.isRunning = false;
                        
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
     * Check if ToolServer is running
     */
    isServerRunning() {
        return this.isRunning;
    }

    /**
     * Get current server port
     */
    getPort() {
        return this.port;
    }

    /**
     * Configure LLM-based intent detection with Ollama client
     * @param {object} ollamaClient - OllamaClient instance
     */
    configureOllamaIntentDetection(ollamaClient) {
        if (this.intentDetector && ollamaClient) {
            this.intentDetector.setOllamaClient(ollamaClient);
            this.log.info('[ToolServer] LLM-based intent detection enabled');
        }
    }

    /**
     * Handle test intent endpoint for debugging
     */
    async _handleTestIntent(req, res) {
        try {
            const { query } = req.body;
            
            if (!query) {
                return res.status(400).json({ error: "query parameter is required" });
            }

            if (!this.intentDetector) {
                return res.status(503).json({ error: "Intent detector not available" });
            }

            const intent = await this.intentDetector.detectControlIntent(query);
            const bestDatapoint = intent.isControl ? await this._findBestMatchingDatapoint(intent.target) : null;
            
            const response = {
                query: query,
                intent: intent,
                bestDatapoint: bestDatapoint,
                allowedForControl: bestDatapoint ? 
                    (this.datapointController && this.datapointController.allowedDatapoints.has(bestDatapoint)) : false,
                debug: {
                    intentDetectorAvailable: !!this.intentDetector,
                    datapointControllerAvailable: !!this.datapointController,
                    allowedDatapointsCount: this.datapointController ? this.datapointController.allowedDatapoints.size : 0
                }
            };

            res.json(response);
            
        } catch (error) {
            this.log.error(`[ToolServer] Test intent error: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * Handle AI control debug status endpoint
     */
    async _handleAIControlDebug(req, res) {
        try {
            const allowedDatapoints = this.datapointController ? 
                Array.from(this.datapointController.allowedDatapoints) : [];
            
            const enabledDatapoints = this.enabledDatapoints ? 
                Array.from(this.enabledDatapoints) : [];

            const response = {
                timestamp: new Date().toISOString(),
                components: {
                    intentDetector: !!this.intentDetector,
                    datapointController: !!this.datapointController,
                    learningSystem: !!this.learningSystem
                },
                datapoints: {
                    enabled: enabledDatapoints,
                    allowedForControl: allowedDatapoints,
                    enabledCount: enabledDatapoints.length,
                    allowedCount: allowedDatapoints.length
                },
                config: {
                    server: `${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}`,
                    intentDetectorLanguages: this.intentDetector ? ['de', 'en', 'fr', 'es'] : []
                }
            };

            res.json(response);
            
        } catch (error) {
            this.log.error(`[ToolServer] AI control debug error: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * Handle direct AI control execution
     */
    async _handleDirectAIControl(req, res) {
        try {
            const { query, target, value, force = false } = req.body;
            
            if (!query && (!target || value === undefined)) {
                return res.status(400).json({ 
                    error: "Either 'query' or both 'target' and 'value' parameters are required" 
                });
            }

            let intent;
            
            if (query) {
                // Process natural language query
                if (!this.intentDetector) {
                    return res.status(503).json({ error: "Intent detector not available" });
                }
                intent = await this.intentDetector.detectControlIntent(query);
            } else {
                // Direct control with target and value
                intent = {
                    isControl: true,
                    target: target,
                    value: value,
                    confidence: 1.0,
                    language: 'en'
                };
            }

            if (!intent.isControl) {
                return res.json({
                    success: false,
                    message: "Query is not recognized as a control command",
                    intent: intent
                });
            }

            // Process the control intent
            const result = await this._processControlIntent(intent, query || `Direct control: ${target} = ${value}`);
            
            if (result.success) {
                res.json({
                    success: true,
                    message: result.message,
                    datapoint: result.datapoint,
                    value: result.value,
                    intent: intent
                });
            } else if (force && target && value !== undefined) {
                // Force mode: try to find and execute directly
                const datapointId = await this._findBestMatchingDatapoint(target);
                if (datapointId && this.datapointController) {
                    const forceResult = await this.datapointController.setDatapointValue(datapointId, value);
                    res.json({
                        success: forceResult.success,
                        message: forceResult.success ? 
                            `Force executed: ${datapointId} = ${value}` : 
                            `Force execution failed: ${forceResult.error}`,
                        datapoint: datapointId,
                        value: value,
                        forced: true,
                        intent: intent
                    });
                } else {
                    res.json({
                        success: false,
                        message: result.error || "No matching datapoint found for force execution",
                        intent: intent
                    });
                }
            } else {
                res.json({
                    success: false,
                    message: result.error || "Control execution failed",
                    intent: intent
                });
            }
            
        } catch (error) {
            this.log.error(`[ToolServer] Direct AI control error: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = ToolServer;
