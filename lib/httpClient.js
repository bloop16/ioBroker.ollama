"use strict";

const axios = require("axios");
const http = require("http");
const https = require("https");

/**
 * Centralized HTTP Client with connection pooling and keep-alive
 * Provides optimized axios instances for all components
 */
class HttpClient {
  constructor() {
    // HTTP Agent with keep-alive and connection pooling
    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000, // 30 seconds
      maxSockets: 10, // Max 10 concurrent connections per host
      maxFreeSockets: 5, // Keep 5 free sockets open
      timeout: 60000, // Socket timeout 60 seconds
    });

    // HTTPS Agent with keep-alive and connection pooling
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 60000,
      rejectUnauthorized: false, // Allow self-signed certificates for local development
    });

    // Default axios instance with optimized configuration
    this.defaultInstance = axios.create({
      timeout: 30000, // 30 second request timeout
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
    });

    // OpenWebUI specific instance
    this.openWebUIInstance = axios.create({
      timeout: 1200000, // 20 minutes timeout for complex AI requests
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      validateStatus: (status) => status < 500,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ioBroker-Ollama/0.4.0",
      },
    });

    // Qdrant specific instance
    this.qdrantInstance = axios.create({
      timeout: 45000, // Vector operations can take time
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      validateStatus: (status) => status < 500,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Ollama specific instance
    this.ollamaInstance = axios.create({
      timeout: 1200000, // 20 minutes timeout for large model operations
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      validateStatus: (status) => status < 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Get default HTTP client instance
   *
   * @returns {object} Default axios instance
   */
  getDefault() {
    return this.defaultInstance;
  }

  /**
   * Get OpenWebUI optimized HTTP client
   *
   * @param {string} apiKey - Optional API key for authentication
   * @returns {object} OpenWebUI axios instance
   */
  getOpenWebUI(apiKey = "") {
    const instance = this.openWebUIInstance;

    // Add or update authorization header
    if (apiKey && typeof apiKey === "string" && apiKey.trim().length > 0) {
      const cleanApiKey = apiKey.replace(/^(Bearer\s+)?/i, "").trim();
      if (cleanApiKey.length > 0) {
        instance.defaults.headers.Authorization = `Bearer ${cleanApiKey}`;
      }
    } else {
      delete instance.defaults.headers.Authorization;
    }

    return instance;
  }

  /**
   * Get Qdrant optimized HTTP client
   *
   * @returns {object} Qdrant axios instance
   */
  getQdrant() {
    return this.qdrantInstance;
  }

  /**
   * Get Ollama optimized HTTP client
   *
   * @returns {object} Ollama axios instance
   */
  getOllama() {
    return this.ollamaInstance;
  }

  /**
   * Create custom HTTP client with specific configuration
   *
   * @param {object} config - Axios configuration
   * @returns {object} Custom axios instance
   */
  createCustom(config = {}) {
    return axios.create({
      timeout: 30000,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      validateStatus: (status) => status < 500,
      ...config,
    });
  }

  /**
   * Get connection statistics for monitoring
   *
   * @returns {object} Connection statistics
   */
  getStats() {
    return {
      http: {
        maxSockets: this.httpAgent.maxSockets,
        freeSockets: Object.keys(this.httpAgent.freeSockets).length,
        sockets: Object.keys(this.httpAgent.sockets).length,
        requests: Object.keys(this.httpAgent.requests).length,
      },
      https: {
        maxSockets: this.httpsAgent.maxSockets,
        freeSockets: Object.keys(this.httpsAgent.freeSockets).length,
        sockets: Object.keys(this.httpsAgent.sockets).length,
        requests: Object.keys(this.httpsAgent.requests).length,
      },
    };
  }

  /**
   * Cleanup and destroy all connections
   */
  destroy() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

// Singleton instance
const httpClient = new HttpClient();

module.exports = httpClient;
