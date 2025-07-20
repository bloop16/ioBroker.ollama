#!/usr/bin/env node

/**
 * Test Script for ioBroker Ollama Tool Server
 * Tests all Tool Server endpoints and functionality
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ToolServerTester {
    constructor() {
        this.baseUrl = process.env.TOOL_SERVER_URL || 'http://localhost:9100';
        this.results = [];
    }

    async log(message, status = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${status}: ${message}`;
        console.log(logMessage);
        this.results.push({ timestamp, status, message });
    }

    async testEndpoint(name, method, endpoint, data = null, expectedStatus = 200) {
        try {
            await this.log(`Testing ${name}...`);
            
            const config = {
                method: method,
                url: `${this.baseUrl}${endpoint}`,
                timeout: 10000
            };
            
            if (data) {
                config.data = data;
                config.headers = { 'Content-Type': 'application/json' };
            }
            
            const response = await axios(config);
            
            if (response.status === expectedStatus) {
                await this.log(`✅ ${name} - Status: ${response.status}`, 'PASS');
                return response.data;
            } else {
                await this.log(`❌ ${name} - Expected: ${expectedStatus}, Got: ${response.status}`, 'FAIL');
                return null;
            }
            
        } catch (error) {
            await this.log(`❌ ${name} - Error: ${error.message}`, 'ERROR');
            return null;
        }
    }

    async testHealthCheck() {
        const result = await this.testEndpoint(
            'Health Check',
            'GET',
            '/health'
        );
        
        if (result) {
            await this.log(`Health Status: ${result.status}, Service: ${result.service}`);
        }
        
        return result;
    }

    async testOpenAPISpec() {
        const result = await this.testEndpoint(
            'OpenAPI Specification',
            'GET',
            '/openapi.json'
        );
        
        if (result) {
            await this.log(`OpenAPI Title: ${result.info?.title}, Version: ${result.info?.version}`);
            await this.log(`Available Paths: ${Object.keys(result.paths || {}).join(', ')}`);
        }
        
        return result;
    }

    async testRAGQuery() {
        const testQueries = [
            "Wie ist die Temperatur?",
            "Welche Geräte sind eingeschaltet?",
            "Status der Beleuchtung",
            "Wann war Martin zuletzt zuhause?"
        ];
        
        const results = [];
        
        for (const query of testQueries) {
            const result = await this.testEndpoint(
                `RAG Query: "${query}"`,
                'POST',
                '/tools/iobroker-rag',
                { query: query, max_results: 3 }
            );
            
            if (result) {
                await this.log(`Query: "${query}"`);
                await this.log(`Answer: ${result.answer?.substring(0, 100)}...`);
                await this.log(`Context items used: ${result.context_used?.length || 0}`);
                results.push(result);
            }
        }
        
        return results;
    }

    async testLegacyEndpoint() {
        const result = await this.testEndpoint(
            'Legacy Python-compatible Endpoint',
            'POST',
            '/tools/get_iobroker_data_answer',
            { 
                user_query: "Status der Smart Home Geräte",
                options: { max_results: 3 }
            }
        );
        
        if (result) {
            await this.log(`Legacy Answer: ${result.answer?.substring(0, 100)}...`);
        }
        
        return result;
    }

    async testErrorHandling() {
        // Test invalid request
        await this.testEndpoint(
            'Invalid RAG Request (no query)',
            'POST',
            '/tools/iobroker-rag',
            { max_results: 5 },
            400
        );
        
        // Test invalid endpoint
        await this.testEndpoint(
            'Invalid Endpoint',
            'GET',
            '/invalid-endpoint',
            null,
            404
        );
    }

    async detectToolServer() {
        await this.log('🔍 Detecting Tool Server...');
        
        // Try common ports
        const ports = [9099, 9100, 9101, 9102];
        
        for (const port of ports) {
            try {
                const testUrl = `http://localhost:${port}`;
                const response = await axios.get(`${testUrl}/health`, { timeout: 2000 });
                
                if (response.status === 200) {
                    this.baseUrl = testUrl;
                    await this.log(`✅ Tool Server found at ${testUrl}`);
                    return true;
                }
            } catch (error) {
                // Continue trying other ports
            }
        }
        
        await this.log('❌ Tool Server not found on any common port');
        return false;
    }

    async runAllTests() {
        await this.log('🚀 Starting ioBroker Ollama Tool Server Tests');
        
        // Detect Tool Server
        const serverFound = await this.detectToolServer();
        if (!serverFound) {
            await this.log('Cannot run tests - Tool Server not accessible');
            return;
        }
        
        // Run all tests
        await this.testHealthCheck();
        await this.testOpenAPISpec();
        await this.testRAGQuery();
        await this.testLegacyEndpoint();
        await this.testErrorHandling();
        
        // Summary
        const passCount = this.results.filter(r => r.status === 'PASS').length;
        const failCount = this.results.filter(r => r.status === 'FAIL').length;
        const errorCount = this.results.filter(r => r.status === 'ERROR').length;
        
        await this.log('📊 Test Summary:');
        await this.log(`✅ Passed: ${passCount}`);
        await this.log(`❌ Failed: ${failCount}`);
        await this.log(`🔥 Errors: ${errorCount}`);
        
        // Save results
        const reportPath = path.join(__dirname, 'tool-server-test-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
        await this.log(`📄 Report saved to: ${reportPath}`);
    }
}

// Run tests if script is called directly
if (require.main === module) {
    const tester = new ToolServerTester();
    tester.runAllTests().catch(console.error);
}

module.exports = ToolServerTester;
