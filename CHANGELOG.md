# Changelog - ioBroker Ollama Adapter

## v0.2.1 (2025-07-20) - Universal Model Compatibility

### 🎯 Major Improvements

#### ✅ Universal Model Compatibility
- **Fixed**: All Ollama models now work with RAG integration
- **Solved**: "model does not support tools" errors eliminated
- **Enhanced**: gemma3:4b, qwen, and other models now fully functional

#### 🔧 Tool Server Enhancements
- **New**: Complete chat processing workflow handled by Tool Server
- **Improved**: Intelligent routing system (Tool Server → OpenWebUI → Ollama)
- **Added**: Automatic RAG enhancement for ALL models
- **Enhanced**: Graceful fallback systems for maximum reliability

#### 🚀 Architecture Improvements
- **Refactored**: OllamaClient chat processing for Tool Server integration
- **Added**: Smart availability checking and routing logic
- **Improved**: Error handling and recovery mechanisms
- **Enhanced**: Request/response workflow optimization

### 🧪 Testing & Validation
- **New**: `tool-server-chat-test.js` - Test chat integration
- **Enhanced**: `tool-server-test.js` - Comprehensive validation
- **Added**: Health check and RAG functionality tests
- **Improved**: Error scenario testing and validation

### 📊 Technical Details

#### New Methods & Functions:
- `_processCompleteChat()` - Complete chat workflow with RAG
- `_generateChatResponse()` - Multi-fallback chat generation  
- `_processChatViaToolServer()` - Tool Server integration
- `_processChatViaDirect()` - Direct OpenWebUI fallback
- `_checkToolServerAvailability()` - Availability checking

#### API Enhancements:
- **New Endpoint**: `POST /chat/completions` - Complete chat processing
- **Enhanced**: OpenAPI specification with better tool definitions
- **Improved**: Request validation and error responses
- **Added**: RAG context information in responses

#### Configuration Updates:
- **Added**: `toolServerUrl` parameter to OllamaClient constructor
- **Enhanced**: Tool Server URL configuration management
- **Improved**: Port and host configuration handling

### 🐛 Bug Fixes
- **Fixed**: Model tool compatibility issues (gemma3:4b, etc.)
- **Resolved**: Chat processing failures with non-tool models
- **Improved**: Error messages and logging clarity
- **Fixed**: Tool Server startup and singleton management

### 📈 Performance Improvements
- **Optimized**: Chat request routing and processing
- **Enhanced**: Memory management and resource cleanup
- **Improved**: Response times through better caching
- **Reduced**: Network overhead with intelligent routing

---

## v0.2.0 (2025-07-15) - OpenWebUI Tool Server Integration

### 🚀 Major Features
- **New**: OpenWebUI Tool Server with RAG functionality
- **Added**: Qdrant vector database integration
- **Implemented**: AI Function-Calling for datapoint control
- **Enhanced**: Context-aware responses with embeddings

### 🔧 Core Implementation
- **Created**: ToolServer class with Express.js API
- **Added**: Vector database client and management
- **Implemented**: Embedding generation and similarity search
- **Created**: DatapointController for AI automation

### 📡 API Endpoints
- **New**: `/tools/iobroker-rag` - RAG query processing
- **Added**: `/openapi.json` - OpenAPI specification
- **Implemented**: `/health` - Health check endpoint
- **Created**: `/tools/get_iobroker_data_answer` - Legacy compatibility

---

## v0.0.3 (2025-07-10) - First Public Release

### ✅ Core Features
- **Implemented**: Ollama model detection and management
- **Added**: Chat API with state mapping
- **Created**: Multi-language support
- **Implemented**: Status monitoring and health checks

### 🔧 Technical Foundation
- **Created**: OllamaClient with OpenWebUI integration
- **Implemented**: State management and model tracking
- **Added**: Configuration interface and validation
- **Created**: Error handling and logging systems

---

## Contributing

This adapter is actively developed and welcomes contributions:

### Development Setup
```bash
git clone https://github.com/bloop16/ioBroker.ollama.git
cd ioBroker.ollama
npm install
npm test
```

### Testing
```bash
# Test Tool Server integration
node test/tool-server-chat-test.js

# Test all functionality
node test/tool-server-test.js
```

### Feature Requests & Bug Reports
Please use GitHub Issues for bug reports and feature requests:
- 🐛 **Bug Reports**: Include logs, configuration, and reproduction steps
- 💡 **Feature Requests**: Describe use case and expected behavior
- 📖 **Documentation**: Help improve setup guides and examples

---

**Links:**
- 📦 [NPM Package](https://www.npmjs.com/package/iobroker.ollama)
- 🐙 [GitHub Repository](https://github.com/bloop16/ioBroker.ollama)
- 📚 [ioBroker Forum](https://forum.iobroker.net/)
- 🤖 [Ollama Documentation](https://ollama.ai/docs)
- 🌐 [OpenWebUI Project](https://github.com/open-webui/open-webui)
