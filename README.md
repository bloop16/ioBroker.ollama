![Logo](admin/ollama.png)
# ioBroker.ollama

[![NPM version](https://img.shields.io/npm/v/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ollama.svg)](https://www.npmjs.com/package/iobroker.ollama)
![Number of Installations](https://iobroker.live/badges/ollama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ollama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ollama.png?downloads=true)](https://nodei.co/npm/iobroker.ollama/)

**Tests:** ![Test and Release](https://github.com/bloop16/ioBroker.ollama/workflows/Test%20and%20Release/badge.svg)

## Ollama Adapter for ioBroker

The ioBroker Ollama adapter enables communication with an Ollama server and allows you to use AI models directly from ioBroker. Messages and configuration parameters are set via datapoints, and the model's responses are returned as states.

### Main Features

- Automatic detection and creation of all available Ollama models as channels and states
- Send messages to a model via states under `models.<modelId>.messages.*` (role, content, images, tool_calls, etc.)
- Build the payload for the Ollama `/api/chat` endpoint from individual states
- Support for all relevant optional parameters (`tools`, `think`, `format`, `options`, `stream`, `keep_alive`)
- Model responses are saved in the state `models.<modelId>.response`
- Status monitoring: Shows if a model is loaded/running and when it expires
- Multilingual interface via translation files

### Example Usage

1. Install the adapter and configure the Ollama server IP/port
2. After startup, all models are automatically created as channels under `ollama.0.models.*`
3. To send a message:
   - Enter the desired role (`user`/`system`/`assistant`) in `models.<modelId>.messages.role`
   - Enter your message in `models.<modelId>.messages.content` and confirm
   - Optionally add images, tool calls, or other parameters
4. The response appears in the state `models.<modelId>.response`

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
- The payload matches the Ollama API specification exactly
- For multi-turn chats, message history can be mapped via states (currently only single message per trigger)

## Changelog

### 0.0.1
* Automatic detection and creation of all Ollama models as channels and states
* Send messages and configuration parameters to Ollama models
* Build the payload for the Ollama /api/chat endpoint from individual states
* Support for all relevant optional parameters (tools, think, format, options, stream, keep_alive)
* Response and details are saved as states
* Status monitoring of models (running, expires)
* Multilingual interface

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