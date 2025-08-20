"use strict";

/**
 * DEPRECATED: Health monitoring service for ioBroker.ollama adapter.
 *
 * This module has been removed as it added unnecessary complexity.
 * ioBroker already provides built-in health monitoring mechanisms.
 *
 * @deprecated This class is no longer used and will be removed in future versions.
 */
class HealthMonitor {
  /**
   * Create a new health monitor
   *
   * @param {ioBroker.Log} log - ioBroker logger instance
   * @param {object} config - Adapter configuration
   */
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.httpClient = null;
    this.server = undefined;
    this.isRunning = false;
    this.healthData = {
      adapter: { status: "unknown", lastCheck: "", uptime: 0 },
      ollama: { status: "unknown", lastCheck: "", models: [] },
      openWebUI: { status: "unknown", lastCheck: "", version: null },
      vectorDb: { status: "unknown", lastCheck: "", collections: [] },
      toolServer: { status: "unknown", lastCheck: "", endpoints: [] },
    };
    this.checkInterval = null;
  }

  /**
   * Initialize health monitoring
   *
   * @param {object} httpClient - HTTP client instance
   * @returns {Promise<void>}
   */
  async initialize(httpClient) {
    this.httpClient = httpClient;
    this.healthData.adapter.status = "starting";
    this.healthData.adapter.lastCheck = new Date().toISOString();

    if (this.config.healthMonitoringEnabled) {
      await this.startHealthServer();
      this.startPeriodicChecks();
    }

    this.log.info("[HealthMonitor] Health monitoring initialized");
  }

  /**
   * Start the health check HTTP server
   *
   * @returns {Promise<void>}
   */
  async startHealthServer() {
    const http = require("http");
    const port = this.config.healthMonitoringPort || 9098;
    const host = this.config.healthMonitoringHost || "127.0.0.1";

    this.server = http.createServer((req, res) => {
      this.handleHealthRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not initialized"));
        return;
      }
      this.server.listen(port, host, (error) => {
        if (error) {
          this.log.error(
            `[HealthMonitor] Failed to start health server: ${error.message}`,
          );
          reject(error);
        } else {
          this.isRunning = true;
          this.log.info(
            `[HealthMonitor] Health server started on ${host}:${port}`,
          );
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming health check requests
   *
   * @param {object} req - HTTP request object
   * @param {object} res - HTTP response object
   */
  handleHealthRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      let responseData;
      let statusCode = 200;

      switch (path) {
        case "/health":
          responseData = this.getOverallHealth();
          statusCode = responseData.status === "healthy" ? 200 : 503;
          break;
        case "/health/adapter":
          responseData = this.getAdapterHealth();
          break;
        case "/health/ollama":
          responseData = this.getOllamaHealth();
          break;
        case "/health/openwebui":
          responseData = this.getOpenWebUIHealth();
          break;
        case "/health/vectordb":
          responseData = this.getVectorDbHealth();
          break;
        case "/health/toolserver":
          responseData = this.getToolServerHealth();
          break;
        case "/metrics":
          responseData = this.getMetrics();
          break;
        default:
          responseData = { error: "Endpoint not found" };
          statusCode = 404;
      }

      res.writeHead(statusCode);
      res.end(JSON.stringify(responseData, null, 2));
    } catch (error) {
      this.log.error(
        `[HealthMonitor] Error handling request: ${error.message}`,
      );
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  /**
   * Get overall system health
   *
   * @returns {object} Overall health status
   */
  getOverallHealth() {
    const services = Object.keys(this.healthData);
    const healthyServices = services.filter(
      (service) => this.healthData[service].status === "healthy",
    );
    const unhealthyServices = services.filter(
      (service) => this.healthData[service].status === "unhealthy",
    );

    const overallStatus =
      unhealthyServices.length === 0 ? "healthy" : "unhealthy";

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services: {
        total: services.length,
        healthy: healthyServices.length,
        unhealthy: unhealthyServices.length,
      },
      details: this.healthData,
    };
  }

  /**
   * Get adapter-specific health
   *
   * @returns {object} Adapter health status
   */
  getAdapterHealth() {
    return {
      ...this.healthData.adapter,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      nodeVersion: process.version,
    };
  }

  /**
   * Get Ollama service health
   *
   * @returns {object} Ollama health status
   */
  getOllamaHealth() {
    return {
      ...this.healthData.ollama,
      timestamp: new Date().toISOString(),
      endpoint: `http://${this.config.ollamaIp}:${this.config.ollamaPort}`,
    };
  }

  /**
   * Get OpenWebUI service health
   *
   * @returns {object} OpenWebUI health status
   */
  getOpenWebUIHealth() {
    return {
      ...this.healthData.openWebUI,
      timestamp: new Date().toISOString(),
      endpoint: `http://${this.config.openWebUIIp}:${this.config.openWebUIPort}`,
    };
  }

  /**
   * Get Vector Database health
   *
   * @returns {object} Vector DB health status
   */
  getVectorDbHealth() {
    return {
      ...this.healthData.vectorDb,
      timestamp: new Date().toISOString(),
      endpoint: `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`,
      enabled: this.config.vectorDbEnabled,
    };
  }

  /**
   * Get ToolServer health
   *
   * @returns {object} ToolServer health status
   */
  getToolServerHealth() {
    return {
      ...this.healthData.toolServer,
      timestamp: new Date().toISOString(),
      endpoint: `http://${this.config.toolServerHost}:${this.config.toolServerPort}`,
      enabled: this.config.toolServerEnabled,
    };
  }

  /**
   * Get system metrics
   *
   * @returns {object} System metrics
   */
  getMetrics() {
    const memUsage = process.memoryUsage();
    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pid: process.pid,
      },
      healthChecks: {
        totalChecks: this.getTotalHealthChecks(),
        lastCheck: this.getLastHealthCheck(),
      },
    };
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks() {
    const interval = this.config.healthCheckInterval || 30000; // 30 seconds default

    this.checkInterval = setInterval(() => {
      this.performHealthChecks();
    }, interval);

    this.log.info(
      `[HealthMonitor] Periodic health checks started (interval: ${interval}ms)`,
    );

    // Perform initial check
    setTimeout(() => this.performHealthChecks(), 1000);
  }

  /**
   * Perform health checks on all services
   *
   * @returns {Promise<void>}
   */
  async performHealthChecks() {
    this.log.debug("[HealthMonitor] Performing health checks");

    // Update adapter health
    this.healthData.adapter.status = "healthy";
    this.healthData.adapter.lastCheck = new Date().toISOString();
    this.healthData.adapter.uptime = process.uptime();

    // Check Ollama
    await this.checkOllamaHealth();

    // Check OpenWebUI
    await this.checkOpenWebUIHealth();

    // Check Vector Database
    if (this.config.vectorDbEnabled) {
      await this.checkVectorDbHealth();
    } else {
      this.healthData.vectorDb.status = "disabled";
    }

    // Check ToolServer
    if (this.config.toolServerEnabled) {
      await this.checkToolServerHealth();
    } else {
      this.healthData.toolServer.status = "disabled";
    }
  }

  /**
   * Check Ollama service health
   *
   * @returns {Promise<void>}
   */
  async checkOllamaHealth() {
    try {
      const ollamaUrl = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;
      const client = this.httpClient.getOllama();
      const response = await client.get(`${ollamaUrl}/api/tags`, {
        timeout: 5000,
      });

      this.healthData.ollama.status = "healthy";
      this.healthData.ollama.lastCheck = new Date().toISOString();
      this.healthData.ollama.models =
        response.data?.models?.map((m) => m.name) || [];
    } catch (error) {
      this.healthData.ollama.status = "unhealthy";
      this.healthData.ollama.lastCheck = new Date().toISOString();
      this.healthData.ollama.error = error.message;
      this.log.warn(
        `[HealthMonitor] Ollama health check failed: ${error.message}`,
      );
    }
  }

  /**
   * Check OpenWebUI service health
   *
   * @returns {Promise<void>}
   */
  async checkOpenWebUIHealth() {
    try {
      const openWebUIUrl = `http://${this.config.openWebUIIp}:${this.config.openWebUIPort}`;
      const client = this.httpClient.getOpenWebUI(this.config.openWebUIApiKey);
      const response = await client.get(`${openWebUIUrl}/api/v1/models`, {
        timeout: 5000,
      });

      this.healthData.openWebUI.status = "healthy";
      this.healthData.openWebUI.lastCheck = new Date().toISOString();
      this.healthData.openWebUI.version =
        response.headers?.["x-version"] || "unknown";
    } catch (error) {
      this.healthData.openWebUI.status = "unhealthy";
      this.healthData.openWebUI.lastCheck = new Date().toISOString();
      this.healthData.openWebUI.error = error.message;
      this.log.warn(
        `[HealthMonitor] OpenWebUI health check failed: ${error.message}`,
      );
    }
  }

  /**
   * Check Vector Database health
   *
   * @returns {Promise<void>}
   */
  async checkVectorDbHealth() {
    try {
      const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
      const client = this.httpClient.getQdrant();
      const response = await client.get(`${qdrantUrl}/collections`, {
        timeout: 5000,
      });

      this.healthData.vectorDb.status = "healthy";
      this.healthData.vectorDb.lastCheck = new Date().toISOString();
      this.healthData.vectorDb.collections =
        response.data?.result?.collections || [];
    } catch (error) {
      this.healthData.vectorDb.status = "unhealthy";
      this.healthData.vectorDb.lastCheck = new Date().toISOString();
      this.healthData.vectorDb.error = error.message;
      this.log.warn(
        `[HealthMonitor] Vector DB health check failed: ${error.message}`,
      );
    }
  }

  /**
   * Check ToolServer health
   *
   * @returns {Promise<void>}
   */
  async checkToolServerHealth() {
    try {
      const client = this.httpClient.getDefault();
      const url = `http://${this.config.toolServerHost}:${this.config.toolServerPort}/health`;
      const response = await client.get(url, { timeout: 5000 });

      this.healthData.toolServer.status = "healthy";
      this.healthData.toolServer.lastCheck = new Date().toISOString();
      this.healthData.toolServer.endpoints = response.data?.endpoints || [];
    } catch (error) {
      this.healthData.toolServer.status = "unhealthy";
      this.healthData.toolServer.lastCheck = new Date().toISOString();
      this.healthData.toolServer.error = error.message;
      this.log.warn(
        `[HealthMonitor] ToolServer health check failed: ${error.message}`,
      );
    }
  }

  /**
   * Get total number of health checks performed
   *
   * @returns {number} Total health checks
   */
  getTotalHealthChecks() {
    return Object.values(this.healthData).reduce((total, service) => {
      return total + (service.lastCheck && service.lastCheck !== "" ? 1 : 0);
    }, 0);
  }

  /**
   * Get timestamp of last health check
   *
   * @returns {string|null} Last check timestamp
   */
  getLastHealthCheck() {
    const timestamps = Object.values(this.healthData)
      .map((service) => service.lastCheck)
      .filter((timestamp) => timestamp && timestamp !== "")
      .sort();

    return timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
  }

  /**
   * Update service health status manually
   *
   * @param {string} service - Service name
   * @param {string} status - Health status
   * @param {object} data - Additional health data
   */
  updateServiceHealth(service, status, data = {}) {
    if (this.healthData[service]) {
      this.healthData[service].status = status;
      this.healthData[service].lastCheck = new Date().toISOString();
      Object.assign(this.healthData[service], data);
    }
  }

  /**
   * Stop health monitoring
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.log.info("[HealthMonitor] Shutting down health monitoring");

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.server && this.isRunning) {
      return new Promise((resolve) => {
        if (this.server) {
          this.server.close(() => {
            this.isRunning = false;
            this.log.info("[HealthMonitor] Health server stopped");
            resolve();
          });
        } else {
          resolve();
        }
      });
    }
  }
}

module.exports = HealthMonitor;
