# 🏗️ **ioBroker.ollama - Architektur-Analyse**

## **📊 SYSTEM-ÜBERSICHT**

```mermaid
graph TB
    %% User Interface Layer
    UI[ioBroker Admin UI] --> Adapter[Main Adapter - main.js]
    
    %% Core Adapter Layer
    Adapter --> Config[ConfigValidator]
    Adapter --> Health[HealthMonitor]
    Adapter --> HTTP[HttpClient]
    
    %% Service Layer
    Adapter --> OllamaClient[OllamaClient]
    Adapter --> ToolServer[ToolServer] 
    Adapter --> DataController[DatapointController]
    Adapter --> Cache[LRUCache]
    
    %% External Services
    OllamaClient --> OpenWebUI[OpenWebUI API]
    OllamaClient --> Ollama[Ollama API]
    ToolServer --> OpenWebUI
    ToolServer --> QdrantDB[(Qdrant Vector DB)]
    DataController --> ioBrokerStates[(ioBroker States)]
    
    %% Data Flow
    QdrantDB --> QdrantHelper[QdrantHelper]
    QdrantHelper --> Adapter
    
    %% Monitoring
    Health --> OpenWebUI
    Health --> Ollama
    Health --> QdrantDB
    Health --> ToolServer
```

## **🔄 DATENFLUSS-DIAGRAMM**

### **1. Chat Request Flow:**
```mermaid
sequenceDiagram
    participant User
    participant Adapter
    participant OllamaClient
    participant ToolServer
    participant OpenWebUI
    participant Ollama
    participant QdrantDB
    participant DataController
    
    User->>Adapter: Chat Message
    Adapter->>OllamaClient: processChatMessage()
    
    Note over OllamaClient: OpenWebUI-First Architecture
    
    OllamaClient->>ToolServer: Primary: Via ToolServer
    ToolServer->>QdrantDB: RAG Context Query
    QdrantDB-->>ToolServer: Relevant Context
    ToolServer->>OpenWebUI: Enhanced Request
    OpenWebUI-->>ToolServer: LLM Response
    ToolServer-->>OllamaClient: Response + Function Calls
    
    alt Function Call Required
        OllamaClient->>DataController: setState/getState
        DataController->>ioBrokerStates: Update State
        ioBrokerStates-->>DataController: Confirmation
        DataController-->>OllamaClient: Result
    end
    
    alt ToolServer Fallback
        OllamaClient->>OpenWebUI: Direct API Call
        OpenWebUI-->>OllamaClient: Response
    end
    
    alt Final Fallback
        OllamaClient->>Ollama: Direct Ollama API
        Ollama-->>OllamaClient: Response
    end
    
    OllamaClient-->>Adapter: Final Response
    Adapter-->>User: Result
```

### **2. Smart Home Control Flow:**
```mermaid
sequenceDiagram
    participant AI as AI/LLM
    participant ToolServer
    participant DataController
    participant ioBroker
    participant SmartDevice
    
    AI->>ToolServer: setState("Licht_Wohnzimmer", true)
    ToolServer->>DataController: executeFunctionCall()
    
    Note over DataController: Permission Check
    DataController->>DataController: Check allowAutoChange=true
    
    alt Permission Granted
        DataController->>ioBroker: setForeignState()
        ioBroker->>SmartDevice: Physical Control
        SmartDevice-->>ioBroker: Status Update
        ioBroker-->>DataController: Confirmation
        DataController-->>ToolServer: Success
        ToolServer-->>AI: Control Confirmed
    else Permission Denied
        DataController-->>ToolServer: Access Denied
        ToolServer-->>AI: Error Response
    end
```

### **3. Vector Database & RAG Flow:**
```mermaid
sequenceDiagram
    participant StateChange as ioBroker State Change
    participant Adapter
    participant QdrantHelper
    participant OpenWebUI
    participant QdrantDB
    participant RAGQuery as RAG Query
    
    StateChange->>Adapter: onStateChange()
    Adapter->>QdrantHelper: processEmbeddingDatapoint()
    QdrantHelper->>OpenWebUI: Generate Embedding
    OpenWebUI-->>QdrantHelper: Vector
    QdrantHelper->>QdrantDB: Store Vector + Metadata
    
    Note over QdrantDB: Retention Policy Applied
    
    RAGQuery->>ToolServer: RAG Request
    ToolServer->>QdrantDB: Vector Similarity Search
    QdrantDB-->>ToolServer: Relevant Datapoints
    ToolServer-->>RAGQuery: Contextual Response
```

## **🔧 KOMPONENTEN-INTERAKTIONEN**

### **Core Components:**

1. **Main Adapter (main.js)**
   - **Rolle**: Zentrale Orchestrierung
   - **Abhängigkeiten**: Alle Module
   - **Verantwortlichkeiten**: 
     - Service-Initialisierung
     - State-Management
     - Error-Handling
     - Cleanup

2. **OllamaClient**
   - **Rolle**: LLM-Integration Manager
   - **Abhängigkeiten**: HttpClient, DatapointController
   - **Architektur**: OpenWebUI-First mit Ollama-Fallback
   - **Funktionen**:
     - Chat-Processing
     - Function-Calling
     - Progress-Monitoring

3. **ToolServer**
   - **Rolle**: OpenWebUI Tools API Provider
   - **Abhängigkeiten**: DatapointController, QdrantHelper
   - **Services**:
     - setState/getState Endpoints
     - RAG Query Endpoint
     - Chat Completions with Tool Integration

4. **DatapointController**
   - **Rolle**: Smart Home State Management
   - **Sicherheit**: Granulare Permissions (read vs write)
   - **Features**:
     - Type Conversion
     - Custom Boolean Values
     - Permission Management

5. **QdrantHelper**
   - **Rolle**: Vector Database Operations
   - **Features**:
     - Embedding Generation
     - Vector Storage
     - RAG Context Retrieval
     - Retention Policy Management

### **Support Components:**

6. **HttpClient**
   - **Rolle**: Centralized HTTP Management
   - **Features**:
     - Connection Pooling
     - Keep-Alive
     - Service-Specific Timeouts

7. **ConfigValidator**
   - **Rolle**: Configuration Safety
   - **Features**:
     - Early Validation
     - Port Conflict Detection
     - Dependency Verification

8. **HealthMonitor**
   - **Rolle**: System Monitoring
   - **Features**:
     - Multi-Service Health Checks
     - HTTP Endpoint for Monitoring
     - Periodic Status Updates

9. **LRUCache**
   - **Rolle**: Memory Management
   - **Features**:
     - State Change Deduplication
     - TTL Support
     - Memory Leak Prevention

## **🔐 SICHERHEITSMODELL**

### **Permission Layers:**
1. **Configuration Level**: `allowAutoChange` flag
2. **Controller Level**: Separate read/write permissions
3. **Adapter Level**: Namespace isolation
4. **API Level**: Request validation

### **Data Protection:**
1. **API Keys**: Encrypted storage in ioBroker
2. **State Access**: Controlled via DatapointController
3. **Network**: HTTPS support, timeout protection
4. **Memory**: LRU cache prevents memory leaks

## **📊 PERFORMANCE CHARAKTERISTIKA**

### **Timeouts & Limits:**
- **LLM Requests**: 20 minutes (1200s)
- **Embeddings**: 5 minutes (300s) 
- **RAG Queries**: 10 minutes (600s)
- **HTTP Default**: 30 seconds
- **Progress Monitoring**: 30-second intervals

### **Caching Strategy:**
- **State Changes**: LRU Cache (1000 items, 5min TTL)
- **HTTP Connections**: Keep-alive pooling
- **Vector DB**: Retention policy for data management

### **Scaling Considerations:**
- **Connection Pooling**: Max 10 sockets per service
- **Memory Management**: LRU cache + periodic cleanup
- **Retry Logic**: Built-in fallback mechanisms

## **🚨 IDENTIFIZIERTE RISIKEN**

### **High Priority:**
1. **Memory Leaks**: Bei großen RAG-Queries
2. **Security**: Unzureichende Input-Validierung
3. **Performance**: Blockierende Retention-Cleanup

### **Medium Priority:**
1. **Error Handling**: Fehlende Circuit-Breaker
2. **Monitoring**: Keine Request-Rate-Limits
3. **Configuration**: API-Key Exposure in Logs

### **Low Priority:**
1. **Code Duplication**: Mehrfache DataController-Updates
2. **Documentation**: Fehlende API-Dokumentation
3. **Testing**: Begrenzte Unit-Test-Abdeckung
