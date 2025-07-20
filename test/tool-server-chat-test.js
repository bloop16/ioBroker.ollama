#!/usr/bin/env node
"use strict";

const axios = require('axios');

/**
 * Test Tool Server Chat Integration
 * Demonstrates the new Option A implementation where Tool Server handles all chat processing
 */
class ToolServerChatTest {
    constructor() {
        this.toolServerUrl = 'http://localhost:9099';
        this.testModel = 'gemma3:4b';
    }

    async runTests() {
        console.log('🧪 Tool Server Chat Integration Test');
        console.log('=====================================');
        console.log('');

        try {
            // Test 1: Health Check
            await this.testHealthCheck();
            
            // Test 2: Complete Chat Processing
            await this.testCompleteChat();
            
            // Test 3: RAG Chat Processing
            await this.testRAGChat();
            
            console.log('✅ All tests completed successfully!');
            
        } catch (error) {
            console.log(`❌ Test failed: ${error.message}`);
        }
    }

    async testHealthCheck() {
        console.log('🔍 Test 1: Tool Server Health Check');
        
        try {
            const response = await axios.get(`${this.toolServerUrl}/health`, { timeout: 3000 });
            
            if (response.status === 200 && response.data.service === 'ioBroker Ollama Tool Server') {
                console.log('✅ Tool Server is healthy and running');
                console.log(`   Service: ${response.data.service}`);
                console.log(`   Status: ${response.data.status}`);
            } else {
                throw new Error('Invalid health check response');
            }
        } catch (error) {
            console.log('⚠️  Tool Server not running - this is expected if adapter is not started');
            console.log('   Run: npm start to start the adapter with Tool Server');
        }
        console.log('');
    }

    async testCompleteChat() {
        console.log('🔍 Test 2: Complete Chat Processing');
        
        const testPayload = {
            model: this.testModel,
            messages: [
                { role: 'user', content: 'Hallo, wie geht es dir?' }
            ],
            temperature: 0.7,
            max_tokens: 512,
            use_rag: false // Disable RAG for this test
        };

        try {
            console.log('   Sending chat request to Tool Server...');
            console.log(`   Model: ${testPayload.model}`);
            console.log(`   Message: "${testPayload.messages[0].content}"`);
            
            const response = await axios.post(`${this.toolServerUrl}/chat/completions`, testPayload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            if (response.data?.choices?.[0]?.message?.content) {
                console.log('✅ Chat processing successful');
                console.log(`   Response: "${response.data.choices[0].message.content.substring(0, 100)}..."`);
                console.log(`   Model: ${response.data.model}`);
                console.log(`   RAG Context: ${response.data.rag_context?.length || 0} items`);
            } else {
                throw new Error('Invalid response format');
            }
        } catch (error) {
            if (error.code === 'ECONNREFUSED') {
                console.log('⚠️  Tool Server not available - adapter needs to be running');
            } else {
                console.log(`❌ Chat processing failed: ${error.message}`);
            }
        }
        console.log('');
    }

    async testRAGChat() {
        console.log('🔍 Test 3: RAG-Enhanced Chat Processing');
        
        const ragPayload = {
            model: this.testModel,
            messages: [
                { role: 'user', content: 'Ist Martin denn zuhause?' }
            ],
            temperature: 0.3,
            max_tokens: 512,
            use_rag: true // Enable RAG for context
        };

        try {
            console.log('   Sending RAG-enhanced chat request...');
            console.log(`   Model: ${ragPayload.model}`);
            console.log(`   Message: "${ragPayload.messages[0].content}"`);
            console.log('   RAG enabled: true');
            
            const response = await axios.post(`${this.toolServerUrl}/chat/completions`, ragPayload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            if (response.data?.choices?.[0]?.message?.content) {
                console.log('✅ RAG chat processing successful');
                console.log(`   Response: "${response.data.choices[0].message.content.substring(0, 100)}..."`);
                console.log(`   RAG Context: ${response.data.rag_context?.length || 0} items used`);
                
                if (response.data.rag_context?.length > 0) {
                    console.log('   📊 Context items:');
                    response.data.rag_context.slice(0, 2).forEach((item, i) => {
                        console.log(`     ${i + 1}. ${item.datapoint_id}: ${item.description}`);
                    });
                }
            } else {
                throw new Error('Invalid response format');
            }
        } catch (error) {
            if (error.code === 'ECONNREFUSED') {
                console.log('⚠️  Tool Server not available - adapter needs to be running');
            } else {
                console.log(`❌ RAG chat processing failed: ${error.message}`);
            }
        }
        console.log('');
    }
}

// Run tests if called directly
if (require.main === module) {
    const tester = new ToolServerChatTest();
    tester.runTests().catch(console.error);
}

module.exports = ToolServerChatTest;
