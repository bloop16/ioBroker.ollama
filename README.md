![Logo](admin/ollama.png)
# ioBroker.ollama

[![NPM version](https://img.shields.io/npm/v/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
![Number of Installations](https://iobroker.live/badges/ollama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ollama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ollama.png?downloads=true)](https://nodei.co/npm/iobroker.ollama/)


## Ollama Adapter for ioBroker

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

- **OpenWebUI (Recommended)**: 
  - Modern web interface that runs on top of Ollama
  - Provides enhanced API capabilities and chat completions endpoint
  - Reachable via network (default: localhost:3000)
  - API key authentication support
  - Falls back to direct Ollama if not available

#### Optional Dependencies (for enhanced features)
- **Qdrant Vector Database**:
  - Version 1.0 or higher
  - Required for context-aware AI responses
  - Reachable via network (default: localhost:6333)
  - Minimum 1GB RAM recommended for vector storage

#### Installation Steps
1. Install Ollama server on your system or network
2. Pull required models: `ollama pull llama3.2` (or your preferred model)
3. For vector features: `ollama pull nomic-embed-text`
4. (Recommended) Install OpenWebUI as frontend: `docker run -d -p 3000:8080 --add-host=host.docker.internal:host-gateway -v open-webui:/app/backend/data --name open-webui --restart always ghcr.io/open-webui/open-webui:main`
5. (Optional) Install and configure Qdrant vector database
6. Install the adapter from ioBroker admin interface
7. Configure the adapter with your server URLs and API credentials

### Main Features

- **Dual Connection Support**: Works with both OpenWebUI (recommended) and direct Ollama connections
- **Model Auto-Discovery**: Automatic detection and creation of all available Ollama models as channels and states
- **Complete Chat API**: Send messages to models via states under `models.<modelId>.messages.*` (role, content, images, tool_calls, etc.)
- **Full Parameter Support**: Support for all Ollama parameters (`tools`, `think`, `format`, `options`, `stream`, `keep_alive`)
- **Real-time Monitoring**: Status monitoring shows if a model is loaded/running and when it expires via direct Ollama connection
- **OpenWebUI Integration**: Enhanced chat completions API with Bearer token authentication
- **Automatic Fallback**: Falls back to direct Ollama connection if OpenWebUI is unavailable
- **Vector Database Integration**: Uses Qdrant for storing and retrieving context-aware embeddings
- **AI Function-Calling**: Automatic datapoint control based on AI model responses
- **Context-Enhanced Chat**: Automatically enhances chat messages with relevant datapoint context

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

### Notes

- The adapter logic is designed to react only to changes in the `messages.content` state and then reads the current configuration from all relevant states
- Chat requests are sent to OpenWebUI if configured with API key, otherwise falls back to direct Ollama connection
- Model status monitoring is always performed via direct Ollama connection for accuracy
- The payload matches the OpenAI/OpenWebUI chat completions API specification
- For multi-turn chats, message history can be mapped via states (currently only single message per trigger)
- OpenWebUI provides additional features like conversation management and user authentication while using Ollama models

### ToDo

- Check for bugs
- Add Websearch if wanted
- Give Ollama the ability to check all ioBroker States
- Enhanced Function calling capabilities
- Multi-turn conversation support
- Image Analysis through OpenWebUI
- OpenWebUI user management integration

## Changelog

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