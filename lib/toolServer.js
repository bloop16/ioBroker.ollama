"use strict";

const express = require("express");
const cors = require("cors");
const net = require("net");
const { QdrantClient } = require("@qdrant/qdrant-js");
const HttpClient = require("./httpClient");
const OllamaClient = require("./ollamaClient");

/**
 * OpenWebUI Tools Server for ioBroker
 * Provides RAG and datapoint control as OpenAPI tools for OpenWebUI
 */
class ToolServer {
  /**
   * @param {object} config - Adapter configuration
   * @param {object} log - Logger instance
   * @param {Set} enabledDatapoints - Set of enabled datapoint IDs for AI features
   * @param {object} datapointController - DatapointController for function calling
   * @param {object} adapter - ioBroker adapter instance for state management
   */
  constructor(config, log, enabledDatapoints, datapointController, adapter) {
    this.config = config;
    this.log = log;
    this.enabledDatapoints = enabledDatapoints;
    this.datapointController = datapointController;
    this.adapter = adapter;

    this.app = express();
    this.server = null;
    this.qdrantClient = null;
    this.isRunning = false;
    this.httpClient = HttpClient; // Use centralized HTTP client

    // Server configuration
    this.host = config.toolServerHost || "0.0.0.0";
    this.port = config.toolServerPort || 9099;
    this.maxPortAttempts = 10;
    this.collectionName = config.vectorDbCollection || "iobroker_datapoints";

    // OpenWebUI/Ollama configuration
    this.openWebUIUrl = OllamaClient.createHttpUrl(
      config.openWebUIIp,
      config.openWebUIPort,
    );
    this.ollamaUrl = OllamaClient.createHttpUrl(
      config.ollamaIp,
      config.ollamaPort,
    );
    this.embeddingModel = config.embeddingModel || "nomic-embed-text";
    this.chatModel = config.toolServerChatModel || "llama3.2:latest";
    this.apiKey = config.openWebUIApiKey || "";

    this._setupExpress();
    this._setupRoutes();
    this._setupCleanup();
  }

  /**
   * Setup cleanup handlers for graceful shutdown
   */
  _setupCleanup() {
    process.on("exit", () => {
      if (this.server) {
        this.log.info("[ToolServer] Server shutting down...");
      }
    });

    process.on("SIGINT", () => {
      this.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      this.stop();
      process.exit(0);
    });
  }

  /**
   * Setup Express middleware
   */
  _setupExpress() {
    this.app.use(cors({ origin: true, credentials: true }));
    this.app.use(express.json({ limit: "50mb" }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  /**
   * Setup all routes for the ToolServer as OpenWebUI Tools API
   */
  _setupRoutes() {
    this.log.debug("[ToolServer] Setting up OpenWebUI Tools API routes...");

    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "ioBroker OpenWebUI Tools Server",
        version: "1.0.0",
        features: {
          rag: !!this.qdrantClient,
          datapoint_control: !!this.datapointController,
          enabled_datapoints: this.enabledDatapoints?.size || 0,
          allowed_datapoints:
            this.datapointController?.allowedDatapoints?.size || 0,
        },
      });
    });

    // OpenAPI spec endpoint for OpenWebUI Tools discovery
    this.app.get("/openapi.json", async (req, res) => {
      try {
        const spec = await this._getEnhancedOpenAPISpec();
        res.json(spec);
      } catch (error) {
        this.log.error(
          `[ToolServer] Error generating OpenAPI spec: ${error.message}`,
        );
        // Fallback to basic spec
        res.json(this._getOpenAPISpec());
      }
    });

    // Root endpoint with API documentation
    this.app.get("/", (req, res) => {
      res.json({
        message: "ioBroker OpenWebUI Tools Server",
        description: "Smart Home Control and RAG Tools for OpenWebUI",
        documentation: "/openapi.json",
        health: "/health",
        tools: {
          setState: "POST /setState - Control ioBroker datapoints",
          getState: "POST /getState - Read ioBroker datapoints",
          ragQuery: "POST /rag_query - Vector database search with AI",
        },
      });
    });

    // OpenWebUI Tools API - setState for datapoint control
    this.app.post("/setState", async (req, res) => {
      await this._handleSetStateRequest(req, res);
    });

    // OpenWebUI Tools API - getState for datapoint reading
    this.app.post("/getState", async (req, res) => {
      await this._handleGetStateRequest(req, res);
    });

    // OpenWebUI Tools API - RAG query for vector database search
    this.app.post("/rag_query", async (req, res) => {
      await this._handleRAGRequest(req, res);
    });

    // Chat completions endpoint for OllamaClient integration
    this.app.post("/chat/completions", async (req, res) => {
      await this._handleChatCompletions(req, res);
    });

    this.log.info(
      "[ToolServer] OpenWebUI Tools API routes configured successfully",
    );
  }

  /**
   * Get enhanced OpenAPI specification with dynamic datapoint information
   */
  async _getEnhancedOpenAPISpec() {
    const spec = require("./openapi-spec.json");

    // Update server URL dynamically
    spec.servers[0].url = OllamaClient.createHttpUrl(
      this.host === "0.0.0.0" ? "localhost" : this.host,
      this.port,
    );

    // Get enhanced datapoint information if available
    try {
      if (this.datapointController?.getEnhancedFunctionDefinitions) {
        const enhancedFunctions =
          await this.datapointController.getEnhancedFunctionDefinitions();
        if (enhancedFunctions.length > 0) {
          this.log.debug(
            "[ToolServer] Using enhanced function definitions with object information",
          );

          // Update the enum for datapoints with detailed information
          const allowedDatapoints = Array.from(
            this.datapointController?.allowedDatapoints || [],
          );

          if (allowedDatapoints.length > 0) {
            // Update setState datapoint enum
            const setStateDatapointSchema =
              spec.paths["/setState"]?.post?.requestBody?.content?.[
                "application/json"
              ]?.schema?.properties?.datapoint;
            if (setStateDatapointSchema) {
              setStateDatapointSchema["enum"] = allowedDatapoints;
              setStateDatapointSchema.description = `The ID of the datapoint to control. Available datapoints: ${allowedDatapoints.join(", ")}`;
            }

            // Update getState datapoint enum
            const getStateDatapointSchema =
              spec.paths["/getState"]?.post?.requestBody?.content?.[
                "application/json"
              ]?.schema?.properties?.datapoint;
            if (getStateDatapointSchema) {
              getStateDatapointSchema["enum"] = allowedDatapoints;
              getStateDatapointSchema.description = `The ID of the datapoint to read. Available datapoints: ${allowedDatapoints.join(", ")}`;
            }
          }
        }
      }
    } catch (error) {
      this.log.debug(
        `[ToolServer] Could not get enhanced function definitions: ${error.message}`,
      );
    }

    return spec;
  }

  /**
   * Get OpenAPI specification for OpenWebUI Tools
   */
  _getOpenAPISpec() {
    const spec = require("./openapi-spec.json");

    // Update server URL dynamically
    spec.servers[0].url = OllamaClient.createHttpUrl(
      this.host === "0.0.0.0" ? "localhost" : this.host,
      this.port,
    );

    // Add allowed datapoints to enum if available
    const allowedDatapoints = Array.from(
      this.datapointController?.allowedDatapoints || [],
    );

    if (allowedDatapoints.length > 0) {
      // Update setState datapoint enum
      const setStateDatapointSchema =
        spec.paths["/setState"]?.post?.requestBody?.content?.[
          "application/json"
        ]?.schema?.properties?.datapoint;
      if (setStateDatapointSchema) {
        setStateDatapointSchema["enum"] = allowedDatapoints;
        setStateDatapointSchema.description = `The ID of the datapoint to control. Available datapoints: ${allowedDatapoints.join(", ")}`;
      }

      // Update getState datapoint enum
      const getStateDatapointSchema =
        spec.paths["/getState"]?.post?.requestBody?.content?.[
          "application/json"
        ]?.schema?.properties?.datapoint;
      if (getStateDatapointSchema) {
        getStateDatapointSchema["enum"] = allowedDatapoints;
        getStateDatapointSchema.description = `The ID of the datapoint to read. Available datapoints: ${allowedDatapoints.join(", ")}`;
      }
    }

    return spec;
  }

  /**
   * Handle setState requests - OpenWebUI Tool
   *
   * @param {object} req - Express request object
   * @param {object} res - Express response object
   */
  async _handleSetStateRequest(req, res) {
    try {
      const { datapoint, value } = req.body;

      if (!datapoint || value === undefined) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: datapoint and value",
        });
      }

      if (!this.datapointController) {
        return res.status(500).json({
          success: false,
          error: "Datapoint controller not available",
        });
      }

      this.log.debug(`[ToolServer] setState request: ${datapoint} = ${value}`);

      // Use the DatapointController's executeSetState which handles ID resolution
      try {
        const result = await this.datapointController.executeSetState({
          datapoint,
          value,
        });

        res.json({
          success: true,
          message: result.message,
          datapoint: result.datapoint,
          originalInput: result.originalInput,
          value: result.value,
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error.message,
        });
      }
    } catch (error) {
      this.log.error(`[ToolServer] setState error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Handle getState requests - OpenWebUI Tool
   *
   * @param {object} req - Express request object
   * @param {object} res - Express response object
   */
  async _handleGetStateRequest(req, res) {
    try {
      const { datapoint } = req.body;

      if (!datapoint) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameter: datapoint",
        });
      }

      if (!this.datapointController) {
        return res.status(500).json({
          success: false,
          error: "Datapoint controller not available",
        });
      }

      this.log.debug(`[ToolServer] getState request: ${datapoint}`);

      // Use the DatapointController's executeGetState which handles ID resolution
      try {
        const result = await this.datapointController.executeGetState({
          datapoint,
        });

        res.json({
          success: true,
          datapoint: result.datapoint,
          originalInput: result.originalInput,
          value: result.value,
          timestamp: result.timestamp || new Date().toISOString(),
          message: result.message,
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error.message,
        });
      }
    } catch (error) {
      this.log.error(`[ToolServer] getState error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Handle RAG requests - OpenWebUI Tool
   *
   * @param {object} req - Express request object
   * @param {object} res - Express response object
   */
  async _handleRAGRequest(req, res) {
    try {
      const { query, maxResults = 5 } = req.body;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameter: query",
        });
      }

      this.log.debug(`[ToolServer] RAG query: "${query}"`);

      if (!this.qdrantClient) {
        // Fallback without vector database
        return res.json({
          success: true,
          query: query,
          answer:
            "Vector database not available. Please enable Qdrant for RAG functionality.",
          context: [],
        });
      }

      // Generate embedding for the query
      const queryEmbedding = await this._generateEmbedding(query);

      // Search for similar datapoints
      const searchResults = await this._searchSimilarDatapoints(
        queryEmbedding,
        maxResults,
      );

      // Build context from search results
      const context = this._buildContext(searchResults, false);

      // Generate contextual answer
      const answer = await this._generateContextualAnswer(query, context);

      res.json({
        success: true,
        query: query,
        answer: answer,
        context: searchResults.map((result) => ({
          datapoint:
            result.payload?.datapoint_id || result.payload?.id || "unknown",
          value: result.payload?.value,
          timestamp: result.payload?.timestamp,
          similarity: result.score,
          description: result.payload?.description,
          location: result.payload?.location,
        })),
      });
    } catch (error) {
      this.log.error(`[ToolServer] RAG error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * Get RAG context without generating answer (for chat completions)
   *
   * @param {string} query - The user's query string
   * @param {number} maxResults - Maximum number of results to return
   */
  async _getRAGContext(query, maxResults = 5) {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this._generateEmbedding(query);

      // Search for similar datapoints
      const searchResults = await this._searchSimilarDatapoints(
        queryEmbedding,
        maxResults,
      );

      // Return context without generating answer
      return searchResults.map((result) => ({
        datapoint:
          result.payload?.datapoint_id || result.payload?.id || "unknown",
        value: result.payload?.value,
        timestamp: result.payload?.timestamp,
        similarity: result.score,
        description: result.payload?.description,
        location: result.payload?.location,
      }));
    } catch (error) {
      this.log.error(
        `[ToolServer] RAG context retrieval error: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Handle chat completions requests for OllamaClient integration
   * Supports OpenAI-compatible function calling for setState/getState
   *
   * @param {object} req - Express request object
   * @param {object} res - Express response object
   */
  async _handleChatCompletions(req, res) {
    let model; // Declare model in outer scope for finally block

    try {
      const {
        model: requestModel,
        messages,
        temperature = 0.7,
        max_tokens = 2048,
        use_rag = false,
      } = req.body;

      model = requestModel; // Assign to outer scope variable

      if (!model || !messages || !Array.isArray(messages)) {
        return res.status(400).json({
          error: "Missing required parameters: model and messages array",
        });
      }

      // Check if model is available in OpenWebUI (optional check)
      if (!(await this._isModelAvailable(model))) {
        this.log.warn(
          `[ToolServer] Model ${model} may not be available in OpenWebUI - proceeding anyway`,
        );
      }

      // Get the last user message for processing
      const lastUserMessage = [...messages]
        .reverse()
        .find((msg) => msg.role === "user");
      if (!lastUserMessage?.content) {
        return res.status(400).json({
          error: "No user message found in messages array",
        });
      }

      const userQuery = lastUserMessage.content;
      this.log.debug(
        `[ToolServer] Chat completion request for: "${userQuery.substring(0, 100)}..."`,
      );

      // Set processing state for the model
      await this._setModelProcessingState(model, true);

      let response;
      let ragContext = [];
      let enhancedMessages = [...messages];

      // Add available tools to the request if datapointController is available
      let availableTools = [];
      if (this.datapointController?.allowedDatapoints?.size > 0) {
        availableTools = this._getOpenAIFunctionDefinitions();
      }

      // RAG enhancement if enabled
      if (use_rag && this.qdrantClient) {
        try {
          this.log.debug(`[ToolServer] Processing with RAG enhancement`);
          this.log.debug(
            `[ToolServer] Using embedding model: ${this.embeddingModel}`,
          );

          // Get RAG context (without generating answer)
          const contextResults = await this._getRAGContext(userQuery, 5);
          ragContext = contextResults;

          this.log.debug(
            `[ToolServer] RAG context: ${ragContext.length} items found`,
          );

          // Build enhanced messages with context
          const contextText = this._buildContext(ragContext, true);

          if (contextText) {
            // Generate dynamic system prompt based on datapoint types and context
            const dynamicPrompt =
              await this._generateDynamicSystemPrompt(ragContext);
            enhancedMessages.unshift({
              role: "system",
              content: dynamicPrompt,
            });
          }
        } catch (ragError) {
          this.log.warn(
            `[ToolServer] RAG enhancement failed: ${ragError.message}, falling back to direct chat`,
          );
          this.log.debug(`[ToolServer] RAG error stack:`, ragError.stack);

          // Check if this is a specific embedding or connection error
          if (ragError.message.includes("status code 500")) {
            this.log.error(
              `[ToolServer] Ollama embedding model error - check if '${this.embeddingModel}' is available`,
            );
          }
        }
      }

      // Call OpenWebUI with tools/functions support
      response = await this._callOpenWebUI(
        model,
        enhancedMessages,
        temperature,
        max_tokens,
        availableTools,
      );

      // Return OpenAI-compatible response format
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: response,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        rag_context: ragContext, // Additional field for debugging
      });
    } catch (error) {
      this.log.error(`[ToolServer] Chat completion error: ${error.message}`);
      res.status(500).json({
        error: {
          message: error.message,
          type: "internal_server_error",
        },
      });
    } finally {
      // Always reset processing state
      await this._setModelProcessingState(model, false);
    }
  }

  /**
   * Convert model name to model ID for state management
   * Converts model names like "llama3.2:latest" to "llama3_2_latest"
   * Uses same logic as OllamaClient to ensure consistency
   *
   * @param {string} modelName - Original model name
   * @returns {string|null} Model ID for ioBroker states
   */
  _getModelIdFromName(modelName) {
    if (!modelName) {
      return null;
    }
    // Use same conversion as OllamaClient: replace all non-alphanumeric chars (except _) with _
    return modelName.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  /**
   * Set processing state for a model
   *
   * @param {string} modelName - Model name
   * @param {boolean} processing - Processing state
   */
  async _setModelProcessingState(modelName, processing) {
    if (!this.adapter || !modelName) {
      return;
    }

    try {
      const modelId = this._getModelIdFromName(modelName);
      if (!modelId) {
        this.log.warn(
          `[ToolServer] Cannot set processing state for invalid model name: ${modelName}`,
        );
        return;
      }

      await this.adapter.setState(
        `models.${modelId}.processing`,
        processing,
        true,
      );
      this.log.debug(
        `[ToolServer] Set processing state for model ${modelName} (${modelId}): ${processing}`,
      );
    } catch (error) {
      this.log.debug(
        `[ToolServer] Could not set processing state for ${modelName}: ${error.message}`,
      );
    }
  }

  /**
   * Get OpenAI-compatible function definitions for available datapoints
   *
   * @returns {Array} Array of OpenAI function definitions
   */
  _getOpenAIFunctionDefinitions() {
    if (!this.datapointController?.allowedDatapoints?.size) {
      return [];
    }

    return this.datapointController.getFunctionDefinitions();
  }

  /**
   * Check if a model is available in OpenWebUI
   *
   * @param {string} model - Model name to check
   * @returns {Promise<boolean>} True if model is available
   */
  async _isModelAvailable(model) {
    try {
      const openWebUIClient = this.httpClient.getOpenWebUI(this.apiKey);
      const response = await openWebUIClient.get(
        `${this.openWebUIUrl}/api/models`,
        { timeout: 5000 },
      );

      if (response.data?.data) {
        const availableModels = response.data.data.map((m) => m.id);
        const isAvailable = availableModels.includes(model);

        if (!isAvailable) {
          this.log.warn(
            `[ToolServer] Model "${model}" not found in OpenWebUI. Available models: ${availableModels.join(", ")}`,
          );
        }

        return isAvailable;
      }

      return false;
    } catch (error) {
      this.log.debug(
        `[ToolServer] Could not check model availability: ${error.message}`,
      );
      return true; // Assume available if check fails
    }
  }

  /**
   * Call OpenWebUI for chat completion with optional tools/functions support
   *
   * @param {string} model - The model to use
   * @param {Array} messages - The conversation messages
   * @param {number} temperature - The temperature setting
   * @param {number} maxTokens - Maximum tokens to generate
   * @param {Array} tools - Optional function definitions
   * @returns {Promise<string>} The response content
   */
  async _callOpenWebUI(model, messages, temperature, maxTokens, tools = []) {
    const payload = {
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens,
      stream: false,
    };

    // Add tools if available
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    try {
      const openWebUIClient = this.httpClient.getOpenWebUI(this.apiKey);
      const response = await openWebUIClient.post(
        `${this.openWebUIUrl}/api/chat/completions`,
        payload,
        { timeout: 1200000 }, // 20 minutes timeout for complex requests
      );

      this.log.debug(
        `[ToolServer] OpenWebUI response structure:`,
        JSON.stringify(response.data, null, 2),
      );

      // Handle function calls if present
      if (response.data?.choices?.[0]?.message?.tool_calls) {
        this.log.debug(
          `[ToolServer] Function calls detected: ${response.data.choices[0].message.tool_calls.length}`,
        );
        return await this._handleFunctionCalls(
          response.data.choices[0].message.tool_calls,
          model,
          messages,
          temperature,
          maxTokens,
        );
      }

      // Return regular message content
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        this.log.warn(
          `[ToolServer] Empty response from OpenWebUI for model ${model}`,
        );
        this.log.debug(
          `[ToolServer] Response details:`,
          JSON.stringify(response.data, null, 2),
        );

        // Additional debugging for empty responses
        if (response.data?.choices?.[0]) {
          const choice = response.data.choices[0];
          this.log.debug(
            `[ToolServer] Choice details - finish_reason: ${choice.finish_reason}, message exists: ${!!choice.message}`,
          );
          if (choice.message) {
            this.log.debug(
              `[ToolServer] Message details - content: "${choice.message.content}", role: ${choice.message.role}`,
            );
          }
        } else {
          this.log.warn(
            `[ToolServer] No choices in response or empty choices array`,
          );
        }

        // Check if it's a model availability issue
        if (response.data?.error) {
          this.log.error(
            `[ToolServer] OpenWebUI returned error for model ${model}: ${JSON.stringify(response.data.error)}`,
          );
          return `Error: Model ${model} returned an error: ${response.data.error.message || "Unknown error"}`;
        }

        return `No response generated from model ${model}. This could indicate that the model is not available in OpenWebUI or not properly configured.`;
      }

      // Check if content looks like a function call attempt (fallback for models that don't use tool_calls properly)
      // Simple pattern to catch basic function call structures - no restrictions on content
      const functionCallPattern =
        /"name"\s*:\s*"(getState|setState)"[\s\S]*?"datapoint"\s*:\s*"([^"]+)"(?:[\s\S]*?"value"\s*:\s*([^}]+?))?/;
      const functionCallMatch = content.match(functionCallPattern);

      if (functionCallMatch) {
        this.log.debug(
          `[ToolServer] Detected text-based function call attempt: ${functionCallMatch[1]} for datapoint: ${functionCallMatch[2]}`,
        );

        try {
          const functionName = functionCallMatch[1];
          const datapoint = functionCallMatch[2];
          let value = functionCallMatch[3];

          // SAFETY: Only reject null/undefined values for system safety
          if (functionName === "setState") {
            if (value === null || value === undefined) {
              this.log.warn(
                `[ToolServer] Rejected setState attempt with null/undefined value for datapoint: ${datapoint}`,
              );
              return `ERROR: Cannot set ${datapoint} to null/undefined value. Please provide a valid value.`;
            }
          }

          // Clean up value if present
          if (value) {
            value = value.replace(/[\\"}]+$/, "").replace(/^[\\"}]+/, "");

            try {
              value = JSON.parse(value);
            } catch (_e) {
              // If parsing fails, use as string
              value = value.toString();
            }
          }

          const parameters = { datapoint };
          if (value !== undefined) {
            parameters.value = value;
          }

          // Log the actual parameters being used
          this.log.info(
            `[ToolServer] Executing text-based function call: ${functionName} with parameters: ${JSON.stringify(parameters)}`,
          );

          // Execute the function call
          const result = await this.datapointController.executeFunctionCall(
            functionName,
            parameters,
          );

          // Generate a natural language response
          if (functionName === "getState") {
            return `Der aktuelle Wert von ${datapoint} ist ${result.value}.`;
          }
          return `Ich habe ${datapoint} auf ${result.value} gesetzt.`;
        } catch (error) {
          this.log.warn(
            `[ToolServer] Text-based function call warning: ${error.message}`,
          );
          return `Entschuldigung, ich konnte den Datenpunkt ${functionCallMatch[2]} nicht verarbeiten: ${error.message}`;
        }
      }

      return content;
    } catch (error) {
      this.log.error(`[ToolServer] OpenWebUI API error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle function calls from the LLM
   *
   * @param {Array} toolCalls - Function calls to execute
   * @param {string} model - The model to use for follow-up
   * @param {Array} originalMessages - Original conversation messages
   * @param {number} temperature - Temperature setting
   * @param {number} maxTokens - Max tokens setting
   * @returns {Promise<string>} The final response
   */
  async _handleFunctionCalls(
    toolCalls,
    model,
    originalMessages,
    temperature,
    maxTokens,
  ) {
    const functionResults = [];

    for (const toolCall of toolCalls) {
      try {
        this.log.debug(
          `[ToolServer] Executing function: ${toolCall.function.name}`,
        );

        const result = await this.datapointController.executeFunctionCall(
          toolCall.function.name,
          JSON.parse(toolCall.function.arguments),
        );

        functionResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: JSON.stringify(result),
        });

        this.log.debug(
          `[ToolServer] Function ${toolCall.function.name} executed successfully`,
        );
      } catch (error) {
        this.log.warn(
          `[ToolServer] Function execution warning: ${error.message}`,
        );

        functionResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: JSON.stringify({ error: error.message }),
        });
      }
    }

    // Create new message history with function results
    const messagesWithFunctions = [
      ...originalMessages,
      {
        role: "assistant",
        tool_calls: toolCalls,
      },
      ...functionResults,
    ];

    // Call OpenWebUI again to get the final response
    const finalPayload = {
      model: model,
      messages: messagesWithFunctions,
      temperature: temperature,
      max_tokens: maxTokens,
      stream: false,
    };

    try {
      const openWebUIClient = this.httpClient.getOpenWebUI(this.apiKey);
      const finalResponse = await openWebUIClient.post(
        `${this.openWebUIUrl}/api/chat/completions`,
        finalPayload,
      );

      return (
        finalResponse.data?.choices?.[0]?.message?.content ||
        "Function executed but no response generated."
      );
    } catch (error) {
      this.log.error(`[ToolServer] Final response error: ${error.message}`);
      return `Functions were executed successfully, but I couldn't generate a final response: ${error.message}`;
    }
  }

  /**
   * Build context text from search results (supports both RAG and vector search results)
   *
   * @param {Array} results - Array of search results
   * @param {boolean} isRAGContext - Whether this is RAG context (true) or vector search results (false)
   */
  _buildContext(results, isRAGContext = false) {
    if (!results || results.length === 0) {
      return isRAGContext ? "" : "No relevant datapoint information found.";
    }

    // Sort by timestamp (newest first) to prioritize recent data
    const sortedResults = [...results].sort((a, b) => {
      const timeA = isRAGContext
        ? new Date(a.timestamp).getTime()
        : new Date(a.payload?.timestamp).getTime();
      const timeB = isRAGContext
        ? new Date(b.timestamp).getTime()
        : new Date(b.payload?.timestamp).getTime();
      return timeB - timeA; // Newest first
    });

    const contextItems = sortedResults.map((result, index) => {
      let datapoint, value, timestamp, description, location;

      if (isRAGContext) {
        // RAG context format
        ({ datapoint, value, timestamp, description, location } = result);
      } else {
        // Vector search result format
        const payload = result.payload;
        datapoint = payload?.datapoint_id || payload?.id || "unknown";
        value = payload?.value;
        timestamp = payload?.timestamp;
        description = payload?.description;
        location = payload?.location;
      }

      const timeStr = timestamp
        ? new Date(timestamp).toLocaleString()
        : "unknown time";

      // Use description if available, otherwise datapoint ID
      const displayName = description || datapoint || "Unknown device";
      const locationStr = location ? ` (${location})` : "";
      const ageIndicator =
        index === 0 ? (isRAGContext ? " [MOST RECENT]" : " (MOST RECENT)") : "";

      // For vector search, use formatted_text if available
      if (!isRAGContext && result.payload?.formatted_text) {
        return `${result.payload.formatted_text} - ${timeStr}${ageIndicator}`;
      }

      return `${displayName}: ${value}${locationStr} - ${timeStr}${ageIndicator}`;
    });

    const prefix = isRAGContext
      ? "Current smart home status (sorted by recency):\n"
      : "Relevant smart home information (sorted by recency):\n";

    return `${prefix}${contextItems.join("\n")}`;
  }

  /**
   * Generate embedding for text using Ollama API
   * OpenWebUI typically doesn't support embedding endpoints, so we use Ollama directly
   *
   * @param {string} text - Text to generate embedding for
   */
  async _generateEmbedding(text) {
    try {
      // Use Ollama directly for embeddings as most OpenWebUI installations don't support embedding endpoints
      const ollamaClient = this.httpClient.getOllama();
      const response = await ollamaClient.post(
        `${this.ollamaUrl}/api/embeddings`,
        {
          model: this.embeddingModel,
          prompt: text, // Ollama format uses "prompt"
        },
        {
          timeout: 300000, // 5 minutes for embeddings
        },
      );

      // Ollama response format: { "embedding": [...] }
      if (response.data?.embedding) {
        this.log.debug(
          `[ToolServer] Ollama embedding successful for model: ${this.embeddingModel}`,
        );
        return response.data.embedding;
      }

      throw new Error("No embedding data received from Ollama");
    } catch (error) {
      this.log.error(
        `[ToolServer] Ollama embedding generation failed: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Search for similar datapoints in Qdrant
   *
   * @param {Array} queryEmbedding - Vector embedding to search for
   * @param {number} limit - Maximum number of results to return
   */
  async _searchSimilarDatapoints(queryEmbedding, limit = 5) {
    try {
      if (!this.qdrantClient) {
        this.log.warn("[ToolServer] Qdrant client not available for search");
        return [];
      }

      const searchResult = await this.qdrantClient.search(this.collectionName, {
        vector: queryEmbedding,
        limit: limit,
        with_payload: true,
      });

      return searchResult || [];
    } catch (error) {
      this.log.error(`[ToolServer] Vector search error: ${error.message}`);
      return [];
    }
  }

  /**
   * Generate contextual answer using OpenWebUI/Ollama
   *
   * @param {string} query - User's original question
   * @param {string} context - Context built from search results
   */
  async _generateContextualAnswer(query, context) {
    try {
      const systemPrompt =
        "You are an ioBroker smart home assistant with analytical capabilities. Use the provided context to answer questions about the smart home status. ALWAYS use the most recent data (marked as [MOST RECENT]) when available. For ALL calculations (averages, sums, totals, max, min, median, count, statistics, trends, etc.), analyze the provided data yourself - do NOT call calculation functions. Show your calculation process clearly. Answer in the same language as the question.";
      const userPrompt = `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer (use the most recent data):`;

      const openWebUIClient = this.httpClient.getOpenWebUI(this.apiKey);
      const response = await openWebUIClient.post(
        `${this.openWebUIUrl}/api/chat/completions`,
        {
          model: this.chatModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 300,
          stream: false,
        },
        {
          timeout: 300000, // 5 minutes for RAG context generation
        },
      );

      if (response.data?.choices?.[0]?.message?.content) {
        return response.data.choices[0].message.content.trim();
      }

      this.log.warn(
        `[ToolServer] No valid response content from OpenWebUI. Response structure:`,
        JSON.stringify(response.data, null, 2),
      );
      return "I couldn't generate a proper answer based on the available data.";
    } catch (error) {
      this.log.error(`[ToolServer] Answer generation error: ${error.message}`);
      this.log.debug(`[ToolServer] Full error:`, error);
      return `I encountered an error while processing your question: ${error.message}`;
    }
  }

  /**
   * Initialize Qdrant connection
   */
  async _initializeQdrant() {
    if (!this.config.useVectorDb) {
      this.log.info("[ToolServer] Vector database disabled in configuration");
      return;
    }

    try {
      this.qdrantClient = new QdrantClient({
        url: OllamaClient.createHttpUrl(
          this.config.vectorDbIp,
          this.config.vectorDbPort,
        ),
      });

      // Test connection
      await this.qdrantClient.getCollections();
      this.log.info("[ToolServer] Qdrant connection established successfully");
    } catch (error) {
      this.log.error(
        `[ToolServer] Qdrant initialization failed: ${error.message}`,
      );
      this.qdrantClient = null;
    }
  }

  /**
   * Find available port starting from the configured port
   *
   * @param {number} startPort - Starting port number to check availability
   */
  async _findAvailablePort(startPort = this.port) {
    for (let i = 0; i < this.maxPortAttempts; i++) {
      const port = startPort + i;
      if (await this._isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(
      `No available port found after ${this.maxPortAttempts} attempts`,
    );
  }

  /**
   * Check if port is available
   *
   * @param {number} port - Port number to check availability
   */
  _isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, this.host, () => {
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
    try {
      // Initialize Qdrant connection
      await this._initializeQdrant();

      // Find available port
      const availablePort = await this._findAvailablePort();

      if (availablePort !== this.port) {
        this.log.warn(
          `[ToolServer] Configured port ${this.port} unavailable, using ${availablePort}`,
        );
        this.port = availablePort;
      }

      // Start server
      this.server = this.app.listen(this.port, this.host, () => {
        this.isRunning = true;
        this.log.info(
          `[ToolServer] OpenWebUI Tools Server started on ${this.host}:${this.port}`,
        );
        this.log.info(
          `[ToolServer] OpenAPI spec: ${OllamaClient.createHttpUrl(this.host, this.port)}/openapi.json`,
        );
        this.log.info(
          `[ToolServer] Available tools: setState, getState, rag_query`,
        );
      });

      return true;
    } catch (error) {
      this.log.error(`[ToolServer] Failed to start: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop the ToolServer
   */
  async stop() {
    if (this.server && this.isRunning) {
      this.log.info("[ToolServer] Stopping OpenWebUI Tools Server...");
      this.server.close();
      this.isRunning = false;
      this.log.info("[ToolServer] Server stopped successfully");
    }
  }

  /**
   * Check if server is running
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
   * Generate dynamic system prompts based on available datapoint types and configurations
   *
   * @param {Array} ragContext - RAG context data
   * @returns {Promise<string>} Generated system prompt
   */
  async _generateDynamicSystemPrompt(ragContext = []) {
    if (!this.datapointController?.allowedDatapoints?.size) {
      return `You are an ioBroker smart home assistant. Answer questions based on available data in the user's language.

${ragContext.length > 0 ? `Context:\n${this._buildContext(ragContext, true)}` : ""}`;
    }

    // Analyze available datapoints to determine types and configurations
    const datapointAnalysis = await this._analyzeDatapointTypes();

    let prompt = `You are an ioBroker smart home assistant with access to setState and getState functions.

AVAILABLE FUNCTIONS:
- getState(datapoint): Read current values
- setState(datapoint, value): Set new values

DATAPOINT CAPABILITIES:`;

    // Add type-specific guidance
    if (datapointAnalysis.boolean.length > 0) {
      prompt += `

BOOLEAN DATAPOINTS (${datapointAnalysis.boolean.length}):
- Accept true/false, on/off, yes/no, 1/0
- Custom values: ${this._getBooleanCustomValues(datapointAnalysis.boolean)}
- Examples: setState("Presence", true), setState("Light", "on")`;
    }

    if (datapointAnalysis.number.length > 0) {
      prompt += `

NUMBER DATAPOINTS (${datapointAnalysis.number.length}):
- Accept numeric values, calculations, ranges
- Support mathematical operations and unit conversions
- Examples: setState("Temperature", 23.5), setState("Brightness", "50%")`;
    }

    if (datapointAnalysis.string.length > 0) {
      prompt += `

STRING/TEXT DATAPOINTS (${datapointAnalysis.string.length}):
- Full text editing capabilities: append, prepend, replace, clear
- JSON manipulation: extract, modify, format
- Text operations: formatting, cleaning, translation
- Examples: 
  * Append: getState("Story") → setState("Story", currentContent + newChapter)
  * Clear: setState("Log", "")
  * JSON: setState("Config", JSON.stringify(newConfig))`;
    }

    prompt += `

GENERAL GUIDELINES:
- Use getState() first when you need current values for modifications
- setState() completely overwrites the datapoint value
- Handle user requests flexibly - they may want to clear, append, replace, or transform data
- For calculations, use current data and perform math yourself
- Respond in the user's language

SAFETY: Only null/undefined values are rejected for safety.`;

    if (ragContext.length > 0) {
      prompt += `

CURRENT DATA CONTEXT:
${this._buildContext(ragContext, true)}`;
    }

    return prompt;
  }

  /**
   * Analyze available datapoints to determine types and configurations
   *
   * @returns {Promise<object>} Analysis results with types and configurations
   */
  async _analyzeDatapointTypes() {
    const analysis = {
      boolean: [],
      number: [],
      string: [],
      customConfigs: new Map(),
    };

    // Ensure arrays can accept the expected object structure
    analysis.boolean.length = 0;
    analysis.number.length = 0;
    analysis.string.length = 0;

    if (!this.datapointController?.allowedDatapoints) {
      return analysis;
    }

    for (const datapointId of this.datapointController.allowedDatapoints) {
      try {
        const obj = await this.adapter?.getForeignObjectAsync?.(datapointId);
        if (obj?.common) {
          const type = obj.common.type;
          const customConfig =
            obj.common.custom?.[this.adapter?.namespace] || {};

          analysis.customConfigs.set(datapointId, customConfig);

          const datapointInfo = {
            id: datapointId,
            shortName: this._getShortName(datapointId),
            config: customConfig,
          };

          switch (type) {
            case "boolean":
              Object.assign(analysis.boolean, {
                [analysis.boolean.length]: datapointInfo,
              });
              analysis.boolean.length += 1;
              break;
            case "number":
              Object.assign(analysis.number, {
                [analysis.number.length]: datapointInfo,
              });
              analysis.number.length += 1;
              break;
            case "string":
            case "text":
            default:
              Object.assign(analysis.string, {
                [analysis.string.length]: datapointInfo,
              });
              analysis.string.length += 1;
              break;
          }
        }
      } catch (error) {
        // Skip datapoints that can't be analyzed
        this.log.debug(
          `[ToolServer] Could not analyze datapoint ${datapointId}: ${error.message}`,
        );
      }
    }

    return analysis;
  }

  /**
   * Get short name from full datapoint ID
   *
   * @param {string} fullId - Full datapoint ID
   * @returns {string} Short name
   */
  _getShortName(fullId) {
    const parts = fullId.split(".");
    return parts[parts.length - 1];
  }

  /**
   * Get boolean custom values summary
   *
   * @param {Array} booleanDatapoints - Array of boolean datapoint configs
   * @returns {string} Summary of custom boolean values
   */
  _getBooleanCustomValues(booleanDatapoints) {
    const customValues = new Set();

    booleanDatapoints.forEach((dp) => {
      if (dp.config.booleanTrueValue) {
        customValues.add(`"${dp.config.booleanTrueValue}"=true`);
      }
      if (dp.config.booleanFalseValue) {
        customValues.add(`"${dp.config.booleanFalseValue}"=false`);
      }
    });

    return customValues.size > 0
      ? Array.from(customValues).join(", ")
      : "standard true/false";
  }
}

module.exports = ToolServer;
