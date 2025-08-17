![Logo](admin/ollama.png)
# ioBroker.ollama

[![NPM version](https://img.shields.io/npm/v/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
![Number of Installations](https://iobroker.live/badges/ollama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ollama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ollama.png?downloads=true)](https://nodei.co/npm/iobroker.ollama/)

### Description

This adapter transforms your ioBroker system into an AI-powered home automation hub by integrating with Ollama's local language models through OpenWebUI. OpenWebUI is a modern web interface that provides enhanced API capabilities while using Ollama as the backend AI engine. The adapter can work with both OpenWebUI (recommended) and direct Ollama connections, offering two main operational modes:

1. **Traditional Chat Mode**: Direct communication with AI models through ioBroker datapoints
2. **Enhanced AI Mode**: Advanced functionality including vector database integration, automatic datapoint control, and native multilingual support

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

- **Qdrant Vector Database**:
  - Version 1.0 or higher
  - Required for context-aware AI responses
  - Reachable via network (default: localhost:6333)
  - Minimum 1GB RAM recommended for vector storage

#### Configuration Guide

**1. Ollama Server Configuration:**
- Install and start Ollama on your system or network
- Pull required models: `ollama pull llama3.2` and `ollama pull nomic-embed-text`
- Ensure Ollama is accessible via network (default: port 11434)
- For embedding features, verify the embedding model is available

**2. OpenWebUI Configuration:**
- Install OpenWebUI as frontend (Docker recommended)
- Configure OpenWebUI to connect to your Ollama server
- Create API key in OpenWebUI Settings → Account → API Keys
- Test connection and model availability

**3. Qdrant Vector Database Configuration:**
- Install Qdrant vector database (Docker recommended)
- Configure Qdrant to be accessible via network (default: port 6333)
- No initial configuration needed - adapter will create collections automatically
- Ensure sufficient memory (minimum 1GB RAM recommended)

**4. ioBroker Adapter Configuration:**

*Connection Tab:*
- **Ollama Server IP**: IP address of your Ollama server (e.g., `192.168.1.100`)
- **Ollama Server Port**: Port of Ollama server (default: `11434`)
- **OpenWebUI Server IP**: IP address of your OpenWebUI server
- **OpenWebUI Server Port**: Port of OpenWebUI server (default: `3000`)
- **OpenWebUI API Key**: API key from OpenWebUI Settings → Account → API Keys
- **Model Running Check Interval**: How often to check if models are running (default: 60000ms)

*Database Tab:*
- **Use Qdrant**: Enable for RAG functionality
- **Qdrant Server IP**: IP address of your Qdrant server (e.g., `192.168.1.200`)
- **Qdrant Server Port**: Port of Qdrant server (default: `6333`)
- **Embedding Model**: Model for creating embeddings (e.g., `nomic-embed-text`)
- **Max Context Results**: Maximum number of context results to retrieve (default: `5`)
- **Vector DB Collection**: Collection name for datapoints (default: `iobroker_datapoints`)

*Tool Server Tab:*
- **Enable Tool Server**: Enable for OpenWebUI RAG integration
- **Tool Server Host**: Host interface (default: `0.0.0.0` for all interfaces)
- **Tool Server Port**: Port for tool server (default: `9099`, auto-adjusts if busy)
- **Chat Model**: Model for RAG processing (e.g., `llama3.2`)
- **Temperature**: Response creativity (default: `0.7`)
- **Max Tokens**: Maximum response length (default: `2048`)

**5. Datapoint Configuration:**
- Go to Objects → your device → Custom Settings
- **Enable for Vector Database**: Include this datapoint in RAG context
- **Enable Auto Change**: Allow AI to control this datapoint
- **Description**: Human-readable description (e.g., "Living room light")
- **Location**: Location of the device (e.g., "Living room")
- **Value for true/false**: Custom text for boolean states
- **Units**: Units for number values (e.g., "°C", "kWh")

**6. OpenWebUI Tool Integration:**
- Open OpenWebUI web interface
- Navigate to Settings → Tools
- Add new tool URL: `http://YOUR_IOBROKER_IP:9099/openapi.json`
- Enable the "ioBroker Qdrant RAG Tool"
- Save settings and restart OpenWebUI if necessary

**7. Testing the Setup:**
- Check adapter logs for successful connections
- Verify models appear in Objects → ollama.0 → models
- Test RAG functionality by asking about your devices in OpenWebUI
- Check vector database population in adapter logs
- Test automatic datapoint control with natural language commands

### Main Features

- **Adaptive Intent Recognition**: Intelligent intent detection with context-aware datapoint control
- **Universal Model Compatibility**: ALL models work with RAG integration through intelligent Tool Server routing
- **Automatic Chat Processing**: Tool Server handles complete chat workflow with seamless RAG enhancement
- **Smart Fallback System**: Automatic fallback from Tool Server → OpenWebUI → Direct Ollama for maximum reliability
- **Enhanced Error Handling**: Robust error management and graceful degradation
- **Dual Connection Support**: Works with both OpenWebUI (recommended) and direct Ollama connections
- **Model Auto-Discovery**: Automatic detection and creation of all available Ollama models as channels and states
- **Complete Chat API**: Send messages to models via states under `models.<modelId>.messages.*` (role, content, images, tool_calls, etc.)
- **Real-time Monitoring**: Status monitoring shows if a model is loaded/running and when it expires via direct Ollama connection
- **Vector Database Integration**: Uses Qdrant for storing and retrieving context-aware embeddings
- **AI Function-Calling**: Automatic datapoint control based on AI model responses
- **Context-Enhanced Chat**: Automatically enhances chat messages with relevant datapoint context
- **OpenWebUI Tool Server**: RAG (Retrieval Augmented Generation) tool integration for direct access to ioBroker data from OpenWebUI chat

### 🚀 OpenWebUI Tool Server Integration

The adapter now includes a powerful **Tool Server** that provides **RAG (Retrieval Augmented Generation)** functionality directly within OpenWebUI. This allows you to ask questions about your smart home data directly in OpenWebUI chat and get contextual answers based on your ioBroker datapoints.

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
- Location: "Haus"
- Units: "l"

Formatted output: "Zählerstand: 1250l (Haus)"
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

### 🏥 HealthMonitor

The integrated **HealthMonitor** is a comprehensive monitoring system that continuously monitors the health of all critical services and provides detailed status information. It offers both HTTP endpoints for external monitoring tools and internal monitoring functions.

#### Monitored Services:
- **Ollama Server**: Connection status, available models, response times
- **OpenWebUI**: API availability, authentication, version
- **Qdrant Vector Database**: Connection, collections, memory usage
- **Tool Server**: API endpoints, functionality, port status
- **Adapter**: Runtime, memory, CPU usage

#### HTTP Endpoints:
```
GET /health           - Overall status of all services
GET /health/ollama    - Detailed Ollama status
GET /health/openwebui - OpenWebUI health data
GET /health/vectordb  - Vector Database status  
GET /health/toolserver- Tool Server metrics
GET /health/adapter   - Adapter system data
```

#### Configuration:
- **Enable Health Monitoring**: Enables continuous monitoring
- **Health Server Host**: Host interface (default: `127.0.0.1`)
- **Health Server Port**: Port for HTTP endpoints (default: `9098`)
- **Check Interval**: Monitoring interval in ms (default: `30000`)

#### Automatic Functions:
- **🔄 Periodic Checks**: Regular status checks of all services
- **📊 Metrics Collection**: Detailed performance and availability data
- **🚨 Error Detection**: Early detection of service problems
- **📈 Trend Analysis**: Monitoring of response times and resource consumption
- **🔗 Service Dependencies**: Intelligent dependency checks

#### Monitoring Integration:
The HealthMonitor can be integrated with external monitoring tools such as Prometheus, Nagios, or Zabbix. The JSON API provides structured data for automated monitoring and alerting.


### ToDo

- Enhanced multi-modal support (images, documents)
- Integration of Websearch Function
- Integrate OpenWebUi into Admin
- Uses Chat Historys

## Changelog

### 0.4.0
* **Enhanced ToolServer Functionality** - Improved datapoint control with intelligent type conversion and multilingual boolean support
* **HealthMonitor** - Comprehensive health monitoring system with HTTP endpoints for all services (Ollama, OpenWebUI, Qdrant, ToolServer, Adapter)
* **Advanced Calculation Handling** - Complete interception of all calculation function calls with intelligent redirection to manual computation
* **Pattern-Free Boolean Conversion** - Eliminated hardcoded keywords, using only custom configuration values from jsonCustom
* **Intelligent ID Resolution** - Enhanced fuzzy matching for datapoint name variations with automatic short name mapping
* **Robust Function Call Processing** - Dual-mode support for structured tool_calls and text-based function call detection
* **Separated Permissions** - Independent read/write permissions for enhanced security (allowedDatapoints vs writeAllowedDatapoints)

### 0.3.1
* **Enhanced Code Quality** - Improved code readability and maintainability through proper documentation

### 0.3.0
* **Adaptive Intent Recognition** - Intelligent intent detection in German and English with context-aware datapoint control
* **Enhanced Dynamic Configuration** - Improved configuration management with most server IPs, ports, and API keys using ioBroker UI configuration
* Enhanced OllamaClient with dynamic URL generation from configuration
* Improved ToolServer with configurable Ollama connections
* Enhanced error handling and logging with multilingual messages for core components
* Updated DatapointController with native i18n integration
* Significant reduction of hardcoded server addresses and ports with reliable fallback defaults

### 0.2.0
* **OpenWebUI Tool Server Integration** - RAG (Retrieval Augmented Generation) functionality directly in OpenWebUI chat
* **Advanced Configuration Interface** - Dedicated Tool Server configuration tab with all necessary settings
* **Singleton Architecture** - Prevents multiple Tool Server instances and ensures stable operation
* **Automatic Tool Discovery** - OpenWebUI automatically detects and integrates the ioBroker RAG tool
* **Semantic Search Enhancement** - AI-powered similarity matching for finding relevant datapoints
* **Multi-language Support** - Tool Server works in German and English with automatic language detection
* **Real-time Context Integration** - Access to current and historical datapoint information in natural language
* **Comprehensive API** - OpenAPI 3.0 compliant with health checks and legacy compatibility
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