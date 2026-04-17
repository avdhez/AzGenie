package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// RequestBody matches the JSON coming from the frontend
type RequestBody struct {
	History      []HistoryMessage `json:"history"`
	UserInput    string           `json:"userInput"`
	IsCorrection bool             `json:"isCorrection"`
	CorrectThing string           `json:"correctThing"`
}

type HistoryMessage struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// ResponseBody matches what the frontend expects back
type ResponseBody struct {
	Question    string `json:"question"`
	IsGuess     bool   `json:"isGuess"`
	FinalAnswer string `json:"finalAnswer,omitempty"`
	IsRateLimit bool   `json:"isRateLimit,omitempty"`
}

// Handler is the serverless function Vercel executes
func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		sendError(w, "SYSTEM ERROR: Missing API Key.")
		return
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		sendError(w, "SYSTEM ERROR: Failed to parse request.")
		return
	}

	ctx := context.Background()
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		sendError(w, "SERVER ERROR: Failed to init client.")
		return
	}
	defer client.Close()

	model := client.GenerativeModel("gemini-1.5-flash")
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{
			genai.Text(`You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept.
            Rules:
            1. Ask ONE question at a time. The user will answer: Yes, No, Maybe, or Don't Know.
            2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
            3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
            4. Do not include markdown tags.`),
		},
	}

	// Handle Correction/Learning Mode
	if reqBody.IsCorrection {
		historyJSON, _ := json.Marshal(reqBody.History)
		learningPrompt := genai.Text("I was thinking of \"" + reqBody.CorrectThing + "\". Review our history: " + string(historyJSON) + ". Learn from this mistake. Reply with strict JSON: {\"question\": \"Got it! I will remember that. Let's play again!\"}")
		
		_, err := model.GenerateContent(ctx, learningPrompt)
		if err != nil {
			handleGenAIError(w, err)
			return
		}
		
		json.NewEncoder(w).Encode(map[string]bool{"reset": true})
		return
	}

	// Build Chat History for Google SDK
	cs := model.StartChat()
	for _, msg := range reqBody.History {
		role := "user"
		if msg.Role == "model" {
			role = "model"
		}
		cs.History = append(cs.History, &genai.Content{
			Parts: []genai.Part{genai.Text(msg.Text)},
			Role:  role,
		})
	}

	// Send the new message
	input := reqBody.UserInput
	if input == "" {
		input = "Let's start!"
	}

	res, err := cs.SendMessage(ctx, genai.Text(input))
	if err != nil {
		handleGenAIError(w, err)
		return
	}

	// Extract and clean the JSON response
	if len(res.Candidates) > 0 && len(res.Candidates[0].Content.Parts) > 0 {
		if textPart, ok := res.Candidates[0].Content.Parts[0].(genai.Text); ok {
			cleanJSON := cleanMarkdown(string(textPart))
			w.Write([]byte(cleanJSON))
			return
		}
	}

	sendError(w, "SERVER ERROR: Empty response from model.")
}

// Helper to strip markdown code blocks
func cleanMarkdown(input string) string {
	input = strings.TrimSpace(input)
	input = strings.TrimPrefix(input, "```json")
	input = strings.TrimPrefix(input, "```")
	input = strings.TrimSuffix(input, "```")
	return strings.TrimSpace(input)
}

// Helper to send standard errors to the frontend
func sendError(w http.ResponseWriter, msg string) {
	json.NewEncoder(w).Encode(ResponseBody{
		Question: msg,
		IsGuess:  false,
	})
}

// Helper to catch rate limits (429) specifically
func handleGenAIError(w http.ResponseWriter, err error) {
	errMsg := err.Error()
	if strings.Contains(errMsg, "429") || strings.Contains(strings.ToLower(errMsg), "quota") {
		json.NewEncoder(w).Encode(ResponseBody{
			Question:    "Whoa, slowing down! The Mystic Node needs to catch its breath. Wait 15 seconds and click your answer again.",
			IsGuess:     false,
			IsRateLimit: true,
		})
		return
	}
	sendError(w, "SERVER ERROR: "+errMsg)
}