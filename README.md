![Logo](admin/ollama.png)
# ioBroker.ollama

[![NPM version](https://img.shields.io/npm/v/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
![Number of Installations](https://iobroker.live/badges/ollama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ollama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ollama.png?downloads=true)](https://nodei.co/npm/iobroker.ollama/)


## Ollama Adapter for ioBroker

🚀 **NEW in v0.2.1: Universal Model Compatibility!** 
Every model now works seamlessly with RAG integration! The Tool Server automatically handles chat processing for ALL models (including those without native tool support like `gemma3:4b`) through intelligent routing and fallback systems.

🎯 **Enhanced in v0.2.0: OpenWebUI Tool Server Integration!** 
Ask your smart home questions directly in OpenWebUI chat and get intelligent answers based on your actual ioBroker data. Simply ask "Wie ist die Temperatur im Wohnzimmer?" or "Which devices are currently on?" and get contextual responses powered by RAG (Retrieval Augmented Generation).

The ioBroker Ollama adapter provides a comprehensive AI integration solution that enables communication with Ollama servers through OpenWebUI frontend and allows you to use AI models directly from ioBroker. OpenWebUI serves as an optional web interface that sits on top of Ollama, providing enhanced API capabilities while still using Ollama as the underlying AI engine. This adapter combines traditional chat functionality with advanced features like vector database integration and AI-driven datapoint control.

### Description

This adapter transforms your ioBroker system into an AI-powered home automation hub by integrating with Ollama's local language models through OpenWebUI. OpenWebUI is a modern web interface that provides enhanced API capabilities while using Ollama as the backend AI engine. The adapter can work with both OpenWebUI (recommended) and direct Ollama connections, offering two main operational modes:

1. **Traditional Chat Mode**: Direct communication with AI models through ioBroker datapoints
2. **Enhanced AI Mode**: Advanced functionality including vector database integration and automatic datapoint control

### Requirements

#### External Dependencies
- **Ollama Server**: 
  - Version 0.1.0 or higher
  - Reachable via network (default: localhost:11434)
  - At least one language model installed (e.g., `llama3.2`, `mistral`)
  - For vector database features: embedding model (e.g., `nomic-embed-text`)

- **OpenWebUI**: 
  - Modern web interface that runs on top of Ollama
  - Provides enhanced API capabilities and chat completions endpoint
  - Reachable via network (default: localhost:3000)
  - API key authentication support
  - Falls back to direct Ollama if not available

#### Optional Dependencies ####
- **Qdrant Vector Database**:
  - Version 1.0 or higher
  - Required for context-aware AI responses
  - Reachable via network (default: localhost:6333)
  - Minimum 1GB RAM recommended for vector storage

#### Installation Steps
1. **Install Ollama server** on your system or network
2. **Pull required models**: `ollama pull llama3.2` (or your preferred model)
3. **For vector features**: `ollama pull nomic-embed-text`
4. **(Recommended) Install OpenWebUI** as frontend: 
   ```bash
   docker run -d -p 3000:8080 --add-host=host.docker.internal:host-gateway \
   -v open-webui:/app/backend/data --name open-webui --restart always \
   ghcr.io/open-webui/open-webui:main
   ```
5. **(Optional) Install Qdrant** vector database:
   ```bash
   docker run -d -p 6333:6333 --name qdrant \
   -v qdrant_storage:/qdrant/storage:z \
   qdrant/qdrant:latest
   ```
6. **Install the adapter** from ioBroker admin interface
7. **Configure the adapter** with your server URLs and API credentials
8. **🆕 For OpenWebUI Tool Integration**:
   - Enable "Use Qdrant" in Database tab
   - Enable "Tool Server" in Tool Server tab  
   - Add tool URL in OpenWebUI: `http://YOUR_IOBROKER_IP:9099/openapi.json`

### Main Features

- **🆕 Universal Model Compatibility**: ALL models now work with RAG integration through intelligent Tool Server routing
- **🆕 Automatic Chat Processing**: Tool Server handles complete chat workflow with seamless RAG enhancement
- **🆕 Smart Fallback System**: Automatic fallback from Tool Server → OpenWebUI → Direct Ollama for maximum reliability
- **🆕 Enhanced Error Handling**: Robust error management and graceful degradation
- **Dual Connection Support**: Works with both OpenWebUI (recommended) and direct Ollama connections
- **Model Auto-Discovery**: Automatic detection and creation of all available Ollama models as channels and states
- **Complete Chat API**: Send messages to models via states under `models.<modelId>.messages.*` (role, content, images, tool_calls, etc.)
- **Full Parameter Support**: Support for all Ollama parameters (`tools`, `think`, `format`, `options`, `stream`, `keep_alive`)
- **Real-time Monitoring**: Status monitoring shows if a model is loaded/running and when it expires via direct Ollama connection
- **OpenWebUI Integration**: Enhanced chat completions API with Bearer token authentication
- **Vector Database Integration**: Uses Qdrant for storing and retrieving context-aware embeddings
- **AI Function-Calling**: Automatic datapoint control based on AI model responses
- **Context-Enhanced Chat**: Automatically enhances chat messages with relevant datapoint context
- **🆕 OpenWebUI Tool Server**: RAG (Retrieval Augmented Generation) tool integration for direct access to ioBroker data from OpenWebUI chat

### 🚀 OpenWebUI Tool Server Integration (NEW!)

The adapter now includes a powerful **Tool Server** that provides **RAG (Retrieval Augmented Generation)** functionality directly within OpenWebUI. This allows you to ask questions about your smart home data directly in OpenWebUI chat and get contextual answers based on your ioBroker datapoints.

### 🎯 Universal Model Compatibility (v0.2.1)

**Problem Solved**: Previously, some models (like `gemma3:4b`) couldn't use tools and would fail with "model does not support tools" errors.

**Solution**: The Tool Server now acts as an intelligent proxy that:
- **Automatically routes** all chat requests through the Tool Server
- **Enhances queries** with RAG context for ALL models (even those without native tool support)
- **Provides seamless fallback** if Tool Server is unavailable
- **Works universally** with any Ollama model

#### Before vs. After:
```
❌ Before: gemma3:4b → "400: model does not support tools"
✅ After:  gemma3:4b → Tool Server → RAG-enhanced response with ioBroker context
```

#### Architecture Flow:
```
ioBroker State → OllamaClient → Tool Server → RAG Enhancement → OpenWebUI/Ollama → Model Response
                                    ↓
                         Automatic context from Qdrant Vector DB
```

#### What is RAG?
RAG combines your smart home data with AI to provide intelligent, context-aware responses. Instead of generic answers, the AI can reference actual device states, historical data, and trends from your ioBroker system.

#### Key Features:
- **Direct OpenWebUI Integration**: Ask questions about your smart home in natural language
- **Semantic Search**: Find relevant datapoints using AI-powered similarity matching
- **Contextual Answers**: Get responses based on actual device data and history
- **Automatic Tool Discovery**: OpenWebUI automatically detects and integrates the tool
- **German/English Support**: Works in multiple languages
- **Real-time Data**: Access current and historical datapoint information

#### Example Usage in OpenWebUI:
```
User: "Wie ist die Temperatur im Wohnzimmer?"
AI: "Die aktuelle Temperatur im Wohnzimmer beträgt 22.5°C (gemessen am 20.07.2025 um 20:15 Uhr)."

User: "Welche Geräte sind gerade eingeschaltet?"
AI: "Aktuell sind folgende Geräte eingeschaltet: Wohnzimmerlampe, Küchenlicht und der Fernseher im Wohnzimmer."

User: "Wann war Martin zuletzt zu Hause?"
AI: "Martin war zuletzt am 20. Juli 2025 um 19:07:33 Uhr zu Hause."

User: "Ist Martin denn zuhause?" (works with ANY model now!)
AI: "Basierend auf den ioBroker Datenpunkten: Ja, Martin ist zuhause."
```

#### Technical Implementation (v0.2.1):
- **Smart Routing**: Chat requests automatically routed through Tool Server
- **RAG Enhancement**: Queries enhanced with relevant context from Qdrant vector database  
- **Model Agnostic**: Works with ALL Ollama models (gemma3:4b, llama3.2, etc.)
- **Graceful Fallback**: Tool Server unavailable → Direct OpenWebUI → Direct Ollama
- **Error Resilience**: Robust error handling with detailed logging

#### Setup Instructions:

1. **Enable Vector Database** in adapter configuration:
   - ✅ Use Qdrant: `true`
   - Configure Qdrant server IP and port
   - Enable datapoints for embedding in device custom settings

2. **Enable Tool Server** in adapter configuration:
   - ✅ Enable Tool Server: `true` (default)
   - Tool Server Host: `0.0.0.0` (all interfaces)
   - Tool Server Port: `9099` (default, auto-adjusts if busy)
   - Chat Model: `llama3.2` (or your preferred model)

3. **Configure OpenWebUI Tool Integration**:
   - Open OpenWebUI web interface
   - Go to **Settings** → **Tools**
   - Add new tool URL: `http://YOUR_IOBROKER_IP:9099/openapi.json`
   - Enable the "ioBroker Qdrant RAG Tool"
   - Save settings

4. **Start Using**:
   - Open any chat in OpenWebUI
   - Ask questions about your smart home in natural language
   - **All models now work**: gemma3:4b, llama3.2, qwen, etc.
   - The AI will automatically use your ioBroker data to provide contextual answers
   - RAG integration happens automatically behind the scenes

### 🔧 Testing & Validation

Use the built-in test framework to validate your setup:
```bash
# Test Tool Server chat integration
node test/tool-server-chat-test.js

# Test complete Tool Server functionality  
node test/tool-server-test.js
```

### 📊 What's New in v0.2.1

#### ✅ Fixed Issues:
- **Model Compatibility**: All models now work with RAG (no more "model does not support tools" errors)
- **Chat Processing**: Complete workflow handled by Tool Server for consistency
- **Error Handling**: Improved error management and fallback systems

#### 🚀 New Features:
- **Universal Model Support**: Every Ollama model works with RAG integration
- **Intelligent Routing**: Automatic Tool Server → OpenWebUI → Ollama fallback chain
- **Enhanced Logging**: Detailed debug information for troubleshooting
- **Test Framework**: Comprehensive testing tools for validation

#### 📈 Performance Improvements:
- **Faster Chat Processing**: Optimized request routing and caching
- **Better Resource Management**: Improved memory usage and cleanup
- **Enhanced Stability**: More robust error recovery and connection handling

#### Technical Details:
- **OpenAPI 3.0 Standard**: Full API specification for tool discovery
- **Singleton Architecture**: Prevents multiple server instances
- **Automatic Port Management**: Finds available ports if default is busy
- **Graceful Error Handling**: Continues working even if components fail
- **Legacy Compatibility**: Works with existing Python-based OpenWebUI tools

### 🛠️ Troubleshooting

#### Common Issues & Solutions:

**"Model does not support tools" Error (Fixed in v0.2.1):**
```
✅ Solution: Update to v0.2.1 - All models now work through Tool Server routing
```

**Tool Server not available:**
```bash
# Check Tool Server status
curl http://localhost:9099/health

# Check adapter logs for Tool Server startup
# Expected: "[ToolServer] OpenWebUI Tool Server started on port 9099"
```

**RAG not working:**
```bash
# Verify Qdrant connection
curl http://localhost:6333/collections

# Check vector database configuration in adapter settings
# Ensure datapoints have "embedding enabled" in custom settings
```

**Chat requests failing:**
```bash
# Test complete chat workflow
curl -X POST http://localhost:9099/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:4b","messages":[{"role":"user","content":"Test"}]}'
```

#### Debug Logging:
Set adapter log level to "debug" to see detailed workflow information:
- `[API] Processing chat via Tool Server`
- `[ToolServer] Applying RAG for query`
- `[ToolServer] Enhanced query with X context items`

### Vector Database Integration

The adapter integrates with Qdrant vector database to provide context-aware AI responses:

#### Data Formatting Examples:

**Boolean Type:**
```
Configuration:
- Description: "Jemand ist"
- Location: "Zuhause"
- Value for true: "anwesend"
- Value for false: "abwesend"

Formatted output: "Jemand ist anwesend (Zuhause)"
```

**Number Type:**
```
Configuration:
- Description: "Zählerstand"
- Location: "Zuhause"
- Units: "l"

Formatted output: "Zählerstand: 1250l (Zuhause)"
```

**Text Type:**
```
Configuration:
- Description: "Rasenroboter"
- Location: "Garten"
- Additional text: "Laufzeit"

Formatted output: "Rasenroboter: (Garten) - Laufzeit 3700"
```

Each formatted entry includes:
- Datapoint ID
- Timestamp
- Original value
- Formatted text for embedding
- Location and description metadata

### Supported States per Model

- `response`: Model response
- `running`: Model is loaded
- `expires`: Expiry time
- `messages.role`: Message role
- `messages.content`: Message content
- `messages.images`: Images as JSON array
- `messages.tool_calls`: Tool calls as JSON array
- `stream`: Enable streaming
- `think`: Enable "think" mode
- `tools`: Tools as JSON
- `keep_alive`: Keep-alive parameter
- `format`: Response format
- `options`: Additional options as JSON

### Troubleshooting

#### Common Issues

**Tool Server won't start:**
- Check if port 9099 is available: `curl http://localhost:9099/health`
- Look for port conflicts in adapter logs
- Try restarting the adapter: ioBroker restart ollama.0

**OpenWebUI doesn't detect the tool:**
- Verify the tool URL: `http://YOUR_IOBROKER_IP:9099/openapi.json`
- Check firewall settings - port 9099 must be accessible
- Ensure both ioBroker and OpenWebUI can reach each other over the network

**RAG queries return "no relevant information":**
- Verify Qdrant is running: `curl http://localhost:6333/collections`
- Check if datapoints are enabled for embedding in Object settings
- Wait a few minutes for initial embedding generation after enabling datapoints

**AI responses are in wrong language:**
- The Tool Server automatically detects language from your questions
- Use consistent language in your queries for best results

#### Logs and Monitoring

Monitor Tool Server status:
```bash
# Check if Tool Server is running
curl http://YOUR_IOBROKER_IP:9099/health

# View OpenAPI specification
curl http://YOUR_IOBROKER_IP:9099/openapi.json

# Test RAG functionality directly
curl -X POST http://YOUR_IOBROKER_IP:9099/tools/iobroker-rag \
  -H "Content-Type: application/json" \
  -d '{"query": "temperature status", "max_results": 3}'
```

Check adapter logs for:
- `[ToolServer] Started on http://0.0.0.0:9099` - Tool Server running
- `[ToolServer] Qdrant connection established` - Database connected
- `[ToolServer] RAG query received` - Questions being processed

### Notes

- The adapter logic is designed to react only to changes in the `messages.content` state and then reads the current configuration from all relevant states
- Chat requests are sent to OpenWebUI if configured with API key, otherwise falls back to direct Ollama connection
- Model status monitoring is always performed via direct Ollama connection for accuracy
- The payload matches the OpenAI/OpenWebUI chat completions API specification
- For multi-turn chats, message history can be mapped via states (currently only single message per trigger)
- OpenWebUI provides additional features like conversation management and user authentication while using Ollama models
- **🆕 Tool Server runs automatically** when vector database is enabled and provides RAG functionality to OpenWebUI
- **🆕 Singleton protection** prevents multiple Tool Server instances and ensures stable operation
- **🆕 The Tool Server uses semantic search** to find relevant datapoints and provides contextual answers based on actual device data

### ToDo

- Enhanced multi-modal support (images, documents)
- Advanced conversation memory and context management
- Integration with external knowledge bases
- Enhanced function calling with complex device interactions
- Real-time streaming responses in Tool Server
- Advanced analytics and usage statistics
- Custom tool development framework
- Integration with other smart home platforms

## Changelog

### 0.2.0 (🆕 Major Update)
* **NEW: OpenWebUI Tool Server Integration** - RAG (Retrieval Augmented Generation) functionality directly in OpenWebUI chat
* **NEW: Advanced Configuration Interface** - Dedicated Tool Server configuration tab with all necessary settings
* **NEW: Singleton Architecture** - Prevents multiple Tool Server instances and ensures stable operation
* **NEW: Automatic Tool Discovery** - OpenWebUI automatically detects and integrates the ioBroker RAG tool
* **NEW: Semantic Search Enhancement** - AI-powered similarity matching for finding relevant datapoints
* **NEW: Multi-language Support** - Tool Server works in German and English with automatic language detection
* **NEW: Real-time Context Integration** - Access to current and historical datapoint information in natural language
* **NEW: Comprehensive API** - OpenAPI 3.0 compliant with health checks and legacy compatibility
* Enhanced vector database integration with improved embedding generation
* Improved error handling and graceful fallback mechanisms
* Better port management with automatic conflict resolution
* Updated documentation with comprehensive setup guides and troubleshooting

### 0.1.0
* OpenWebUI integration with automatic fallback to direct Ollama
* Enhanced chat completions API support with Bearer token authentication  
* Vector Database integration with Qdrant
* AI Function-Calling for datapoint control
* Enhanced context-aware responses
* Improved connection handling and error recovery

### 0.0.3
* Ready for first public release
* All compliance warnings fixed

### 0.0.2
* Fixed: [W508] attribute "xs" for number should specify a value of "12" at admin/jsonConfig.json/items/checkOllamaModelRunning
* Fixed: [W156] admin 7.0.23 listed as dependency but 7.4.10 is recommended. Updated globalDependency in io-package.json
* Fixed: [W168] "common.keywords" should not contain "iobroker, adapter, smart home" in io-package.json
* Fixed: [W040] "keywords" within package.json should contain "ioBroker"
* Fixed: [E802] No topics found in the repository. Added topics in GitHub repository settings
* Fixed: [E157] js-controller 5.0.0 listed as dependency but 5.0.19 is required as minimum. Updated dependency in io-package.json
* Fixed: [E112] extIcon must be the same as icon but with github path in io-package.json

### 0.0.1
* Automatic detection and creation of all Ollama models as channels and states
* Send messages and configuration parameters to AI models via OpenWebUI or direct Ollama
* Build the payload for OpenWebUI chat completions and Ollama /api/chat endpoints from individual states
* Support for all relevant optional parameters (tools, think, format, options, stream, keep_alive)
* Response and details are saved as states
* Status monitoring of models via direct Ollama connection (running, expires)
* Multilingual interface
* Automatic fallback between OpenWebUI and Ollama connections

## License
MIT License

Copyright (c) 2025 bloop16 <bloop16@hotmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.