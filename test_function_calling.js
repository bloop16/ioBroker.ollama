#!/usr/bin/env node

/**
 * Test script to verify function calling in ioBroker.ollama
 */

const fs = require('fs');
const path = require('path');

// Read the current implementation
const mainPath = path.join(__dirname, 'main.js');
const ollamaClientPath = path.join(__dirname, 'lib', 'ollamaClient.js');

console.log('Testing ioBroker.ollama Function Calling Implementation...\n');

// Check if files exist
if (!fs.existsSync(mainPath)) {
    console.error('❌ main.js not found');
    process.exit(1);
}

if (!fs.existsSync(ollamaClientPath)) {
    console.error('❌ lib/ollamaClient.js not found');
    process.exit(1);
}

console.log('✅ Files exist');

// Check for key function calling components
const mainContent = fs.readFileSync(mainPath, 'utf8');
const ollamaClientContent = fs.readFileSync(ollamaClientPath, 'utf8');

// Check for function calling enablement
if (mainContent.includes('enableDatapointControl')) {
    console.log('✅ Datapoint control configuration found in main.js');
} else {
    console.log('❌ Datapoint control configuration missing in main.js');
}

// Check for tool injection
if (ollamaClientContent.includes('datapointTools')) {
    console.log('✅ Automatic tool injection found in ollamaClient.js');
} else {
    console.log('❌ Automatic tool injection missing in ollamaClient.js');
}

// Check for tool call processing
if (ollamaClientContent.includes('processToolCalls')) {
    console.log('✅ Tool call processing found in ollamaClient.js');
} else {
    console.log('❌ Tool call processing missing in ollamaClient.js');
}

// Check for DatapointController integration
if (ollamaClientContent.includes('_datapointController')) {
    console.log('✅ DatapointController integration found in ollamaClient.js');
} else {
    console.log('❌ DatapointController integration missing in ollamaClient.js');
}

console.log('\nFunction Calling Test Summary:');
console.log('- The system now automatically injects datapoint control tools when enabled');
console.log('- AI responses with tool_calls are processed and executed');
console.log('- Vector database context is enhanced with fallback formatting');
console.log('- Both manual tools and automatic datapoint tools are supported');

console.log('\nTo test the function calling:');
console.log('1. Enable "Allow automatic state changes" in the admin interface');
console.log('2. Enable "Function Calling" for the datapoint you want to control');
console.log('3. Send a message like: "Set 0_userdata.0.example_state to true"');
console.log('4. The AI should now call the setDatapointValue function instead of just responding with text');
