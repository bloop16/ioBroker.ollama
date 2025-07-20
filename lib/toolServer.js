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
     */
    constructor(config, log, enabledDatapoints) {
        this.config = config;
        this.log = log;
        this.enabledDatapoints = enabledDatapoints;
        
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
                            description: "Searches ioBroker datapoint history using vector similarity and provides contextual answers",
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
                                                    description: "User question about smart home status, devices, or historical data"
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
                                    description: "Successful response with contextual answer",
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
     * Process complete chat with automatic RAG integration
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
                        const enhancedContent = `Kontext aus ioBroker Datenpunkten:\n${context}\n\nBenutzeranfrage: ${userQuery}`;
                        
                        // Replace the last user message with enhanced version
                        finalMessages[finalMessages.length - 1] = {
                            ...userMessage,
                            content: enhancedContent
                        };
                        
                        contextUsed = contextResults.map(result => ({
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
                rag_context: contextUsed // Custom field for debugging
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
            if (this.controller.isRunning()) {
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
