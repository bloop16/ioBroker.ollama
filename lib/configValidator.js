"use strict";

/**
 * Configuration validator for ioBroker.ollama
 * Provides early validation and sanitization of adapter configuration
 */
class ConfigValidator {
  /**
   * Create a new configuration validator
   *
   * @param {ioBroker.Log} log - ioBroker logger instance
   */
  constructor(log) {
    this.log = log;
  }

  /**
   * Validate complete adapter configuration
   *
   * @param {object} config - Adapter configuration object
   * @returns {{isValid: boolean, errors: string[], warnings: string[], sanitized: object}} Validation result with sanitized config
   */
  validateConfig(config) {
    // Initialize result with proper typing
    const errors = [];
    const warnings = [];
    const sanitized = {};
    let isValid = true;

    try {
      // Validate OpenWebUI configuration
      const openWebUIValidation = this.validateOpenWebUI(config);
      errors.push(...openWebUIValidation.errors);
      warnings.push(...openWebUIValidation.warnings);
      Object.assign(sanitized, openWebUIValidation.sanitized);

      // Validate Ollama configuration
      const ollamaValidation = this.validateOllama(config);
      errors.push(...ollamaValidation.errors);
      warnings.push(...ollamaValidation.warnings);
      Object.assign(sanitized, ollamaValidation.sanitized);

      // Validate Vector Database configuration
      const vectorDbValidation = this.validateVectorDb(config);
      errors.push(...vectorDbValidation.errors);
      warnings.push(...vectorDbValidation.warnings);
      Object.assign(sanitized, vectorDbValidation.sanitized);

      // Validate ToolServer configuration
      const toolServerValidation = this.validateToolServer(config);
      errors.push(...toolServerValidation.errors);
      warnings.push(...toolServerValidation.warnings);
      Object.assign(sanitized, toolServerValidation.sanitized);

      // Check for critical dependency conflicts
      const dependencyValidation = this.validateDependencies(sanitized);
      errors.push(...dependencyValidation.errors);
      warnings.push(...dependencyValidation.warnings);

      // Determine overall validity
      isValid = errors.length === 0;

      // Log validation results
      if (errors.length > 0) {
        this.log.error(
          `[ConfigValidator] Configuration validation failed with ${errors.length} errors:`,
        );
        errors.forEach((error) =>
          this.log.error(`[ConfigValidator] ERROR: ${error}`),
        );
      }

      if (warnings.length > 0) {
        this.log.warn(
          `[ConfigValidator] Configuration validation completed with ${warnings.length} warnings:`,
        );
        warnings.forEach((warning) =>
          this.log.warn(`[ConfigValidator] WARNING: ${warning}`),
        );
      }

      if (errors.length === 0 && warnings.length === 0) {
        this.log.info(
          "[ConfigValidator] Configuration validation passed successfully",
        );
      }
    } catch (error) {
      errors.push(`Configuration validation failed: ${error.message}`);
      isValid = false;
    }

    return {
      isValid,
      errors,
      warnings,
      sanitized,
    };
  }

  /**
   * Validate OpenWebUI specific configuration
   *
   * @param {object} config - Configuration object
   * @returns {{errors: string[], warnings: string[], sanitized: object}} OpenWebUI validation result
   */
  validateOpenWebUI(config) {
    const errors = [];
    const warnings = [];
    const sanitized = {};

    // Validate OpenWebUI IP address
    if (!config.openWebUIIp || config.openWebUIIp.trim() === "") {
      errors.push("OpenWebUI IP address is required");
    } else if (!this.isValidIPOrHostname(config.openWebUIIp)) {
      errors.push(`Invalid OpenWebUI IP address: ${config.openWebUIIp}`);
    } else {
      sanitized.openWebUIIp = config.openWebUIIp.trim();
    }

    // Validate OpenWebUI port
    if (!config.openWebUIPort) {
      warnings.push("OpenWebUI port not specified, using default 3000");
      sanitized.openWebUIPort = 3000;
    } else if (!this.isValidPort(config.openWebUIPort)) {
      errors.push(`Invalid OpenWebUI port: ${config.openWebUIPort}`);
    } else {
      sanitized.openWebUIPort = parseInt(config.openWebUIPort, 10);
    }

    // Validate API key
    if (!config.openWebUIApiKey || config.openWebUIApiKey.trim() === "") {
      warnings.push("OpenWebUI API key is empty - authentication may fail");
      sanitized.openWebUIApiKey = "";
    } else {
      sanitized.openWebUIApiKey = config.openWebUIApiKey.trim();
      if (sanitized.openWebUIApiKey.length < 10) {
        warnings.push(
          "OpenWebUI API key seems too short - verify it's correct",
        );
      }
    }

    return { errors, warnings, sanitized };
  }

  /**
   * Validate Ollama specific configuration
   *
   * @param {object} config - Configuration object
   * @returns {{errors: string[], warnings: string[], sanitized: object}} Ollama validation result
   */
  validateOllama(config) {
    const errors = [];
    const warnings = [];
    const sanitized = {};

    // Validate Ollama IP address
    if (!config.ollamaIp || config.ollamaIp.trim() === "") {
      warnings.push("Ollama IP not specified, using default 127.0.0.1");
      sanitized.ollamaIp = "127.0.0.1";
    } else if (!this.isValidIPOrHostname(config.ollamaIp)) {
      errors.push(`Invalid Ollama IP address: ${config.ollamaIp}`);
    } else {
      sanitized.ollamaIp = config.ollamaIp.trim();
    }

    // Validate Ollama port
    if (!config.ollamaPort) {
      warnings.push("Ollama port not specified, using default 11434");
      sanitized.ollamaPort = 11434;
    } else if (!this.isValidPort(config.ollamaPort)) {
      errors.push(`Invalid Ollama port: ${config.ollamaPort}`);
    } else {
      sanitized.ollamaPort = parseInt(config.ollamaPort, 10);
    }

    // Validate model monitoring interval
    if (config.modelMonitoringInterval) {
      const interval = parseInt(config.modelMonitoringInterval, 10);
      if (isNaN(interval) || interval < 1000) {
        warnings.push(
          "Invalid model monitoring interval, using default 60000ms",
        );
        sanitized.modelMonitoringInterval = 60000;
      } else if (interval < 5000) {
        warnings.push(
          "Model monitoring interval is very low, may impact performance",
        );
        sanitized.modelMonitoringInterval = interval;
      } else {
        sanitized.modelMonitoringInterval = interval;
      }
    } else {
      sanitized.modelMonitoringInterval = 60000;
    }

    return { errors, warnings, sanitized };
  }

  /**
   * Validate Vector Database configuration
   *
   * @param {object} config - Configuration object
   * @returns {{errors: string[], warnings: string[], sanitized: object}} Vector database validation result
   */
  validateVectorDb(config) {
    const errors = [];
    const warnings = [];
    const sanitized = {};

    // Check if vector database is enabled
    sanitized.useVectorDb = Boolean(config.useVectorDb);

    if (!sanitized.useVectorDb) {
      warnings.push(
        "Vector database is disabled - RAG functionality will not be available",
      );
      return { errors, warnings, sanitized };
    }

    // Validate Qdrant IP address
    if (!config.vectorDbIp || config.vectorDbIp.trim() === "") {
      warnings.push("Qdrant IP not specified, using default 127.0.0.1");
      sanitized.vectorDbIp = "127.0.0.1";
    } else if (!this.isValidIPOrHostname(config.vectorDbIp)) {
      errors.push(`Invalid Qdrant IP address: ${config.vectorDbIp}`);
    } else {
      sanitized.vectorDbIp = config.vectorDbIp.trim();
    }

    // Validate Qdrant port
    if (!config.vectorDbPort) {
      warnings.push("Qdrant port not specified, using default 6333");
      sanitized.vectorDbPort = 6333;
    } else if (!this.isValidPort(config.vectorDbPort)) {
      errors.push(`Invalid Qdrant port: ${config.vectorDbPort}`);
    } else {
      sanitized.vectorDbPort = parseInt(config.vectorDbPort, 10);
    }

    // Validate embedding model
    if (!config.embeddingModel || config.embeddingModel.trim() === "") {
      warnings.push(
        "Embedding model not specified, using default 'nomic-embed-text'",
      );
      sanitized.embeddingModel = "nomic-embed-text";
    } else {
      sanitized.embeddingModel = config.embeddingModel.trim();
    }

    // Validate max context results
    if (config.maxContextResults) {
      const maxResults = parseInt(config.maxContextResults, 10);
      if (isNaN(maxResults) || maxResults < 1) {
        warnings.push("Invalid max context results, using default 5");
        sanitized.maxContextResults = 5;
      } else if (maxResults > 20) {
        warnings.push(
          "Max context results is very high, may impact performance",
        );
        sanitized.maxContextResults = maxResults;
      } else {
        sanitized.maxContextResults = maxResults;
      }
    } else {
      sanitized.maxContextResults = 5;
    }

    // Validate vector collection name
    if (
      !config.vectorCollectionName ||
      config.vectorCollectionName.trim() === ""
    ) {
      warnings.push(
        "Vector collection name not specified, using default 'iobroker_datapoints'",
      );
      sanitized.vectorCollectionName = "iobroker_datapoints";
    } else {
      sanitized.vectorCollectionName = config.vectorCollectionName.trim();
    }

    return { errors, warnings, sanitized };
  }

  /**
   * Validate ToolServer configuration
   *
   * @param {object} config - Configuration object
   * @returns {{errors: string[], warnings: string[], sanitized: object}} ToolServer validation result
   */
  validateToolServer(config) {
    const errors = [];
    const warnings = [];
    const sanitized = {};

    // Check if ToolServer is enabled
    sanitized.enableToolServer = Boolean(config.enableToolServer);

    if (!sanitized.enableToolServer) {
      warnings.push(
        "ToolServer is disabled - OpenWebUI Tools API will not be available",
      );
      return { errors, warnings, sanitized };
    }

    // Validate ToolServer host
    if (!config.toolServerHost || config.toolServerHost.trim() === "") {
      warnings.push("ToolServer host not specified, using default '0.0.0.0'");
      sanitized.toolServerHost = "0.0.0.0";
    } else {
      sanitized.toolServerHost = config.toolServerHost.trim();
    }

    // Validate ToolServer port
    if (!config.toolServerPort) {
      warnings.push("ToolServer port not specified, using default 9099");
      sanitized.toolServerPort = 9099;
    } else if (!this.isValidPort(config.toolServerPort)) {
      errors.push(`Invalid ToolServer port: ${config.toolServerPort}`);
    } else {
      sanitized.toolServerPort = parseInt(config.toolServerPort, 10);
    }

    // Validate chat model
    if (
      !config.toolServerChatModel ||
      config.toolServerChatModel.trim() === ""
    ) {
      warnings.push(
        "ToolServer chat model not specified, using default 'llama3.2'",
      );
      sanitized.toolServerChatModel = "llama3.2";
    } else {
      sanitized.toolServerChatModel = config.toolServerChatModel.trim();
    }

    // Validate temperature
    if (config.toolServerTemperature !== undefined) {
      const temp = parseFloat(config.toolServerTemperature);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        warnings.push("Invalid temperature value, using default 0.7");
        sanitized.toolServerTemperature = 0.7;
      } else {
        sanitized.toolServerTemperature = temp;
      }
    } else {
      sanitized.toolServerTemperature = 0.7;
    }

    // Validate max tokens
    if (config.toolServerMaxTokens !== undefined) {
      const maxTokens = parseInt(config.toolServerMaxTokens, 10);
      if (isNaN(maxTokens) || maxTokens < 1) {
        warnings.push("Invalid max tokens value, using default 2048");
        sanitized.toolServerMaxTokens = 2048;
      } else {
        sanitized.toolServerMaxTokens = maxTokens;
      }
    } else {
      sanitized.toolServerMaxTokens = 2048;
    }

    return { errors, warnings, sanitized };
  }

  /**
   * Validate dependencies between different configuration sections
   *
   * @param {object} config - Sanitized configuration object
   * @returns {{errors: string[], warnings: string[]}} Dependency validation result
   */
  validateDependencies(config) {
    const errors = [];
    const warnings = [];

    // ToolServer requires Vector Database
    if (config.enableToolServer && !config.useVectorDb) {
      errors.push("ToolServer requires Vector Database to be enabled");
    }

    // Check for port conflicts
    const usedPorts = [];
    if (config.openWebUIPort) {
      usedPorts.push({ port: config.openWebUIPort, service: "OpenWebUI" });
    }
    if (config.ollamaPort) {
      usedPorts.push({ port: config.ollamaPort, service: "Ollama" });
    }
    if (config.vectorDbPort) {
      usedPorts.push({ port: config.vectorDbPort, service: "Qdrant" });
    }
    if (config.toolServerPort) {
      usedPorts.push({ port: config.toolServerPort, service: "ToolServer" });
    }

    const portConflicts = this.checkPortConflicts(usedPorts);
    errors.push(...portConflicts);

    return { errors, warnings };
  }

  /**
   * Check for port conflicts between services
   *
   * @param {Array<{port: number, service: string}>} usedPorts - List of used ports
   * @returns {string[]} Array of conflict error messages
   */
  checkPortConflicts(usedPorts) {
    const conflicts = [];
    const portMap = new Map();

    for (const { port, service } of usedPorts) {
      if (portMap.has(port)) {
        conflicts.push(
          `Port conflict: ${service} and ${portMap.get(port)} both use port ${port}`,
        );
      } else {
        portMap.set(port, service);
      }
    }

    return conflicts;
  }

  /**
   * Validate if a string is a valid IP address or hostname
   *
   * @param {string} value - Value to validate
   * @returns {boolean} True if valid IP or hostname
   */
  isValidIPOrHostname(value) {
    if (!value || typeof value !== "string") {
      return false;
    }

    // Check for valid IPv4
    const ipv4Regex =
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (ipv4Regex.test(value)) {
      return true;
    }

    // Check for valid hostname/FQDN
    const hostnameRegex =
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return hostnameRegex.test(value) && value.length <= 253;
  }

  /**
   * Validate if a value is a valid port number
   *
   * @param {string|number} port - Port value to validate
   * @returns {boolean} True if valid port
   */
  isValidPort(port) {
    const portStr = String(port);
    const portNum = parseInt(portStr, 10);
    return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
  }
}

module.exports = ConfigValidator;
