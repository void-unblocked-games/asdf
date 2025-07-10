#!/bin/bash

echo "This script will set up Qwen 2.5 0.5b using Ollama."

# Check if Ollama is already installed
if ! command -v ollama &> /dev/null
then
    echo "Ollama is not found. Please install Ollama manually from ollama.com/download."
    exit 1
fi

echo "Ollama is already installed. Proceeding to download and run Qwen 2.5 0.5b model..."
ollama run qwen2.5:0.5b

echo "Setup script finished."