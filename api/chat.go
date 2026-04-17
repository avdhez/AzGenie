package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// ── Constants ────────────────────────────────────────────────────────────────

const (
	geminiModel  = "gemini-2.0-flash"
	geminiURL    = "https://generativelanguage.googleapis.com/v1beta/models/" + geminiModel + ":generateContent"
	systemPrompt = `You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept in existence.
Rules:
1. Ask ONE YES/NO question at a time.
2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
4. Do not include markdown tags.`
)

// ── Frontend request / response types ────────────────────────────────────────

type frontendRequest struct {
	History      []historyItem `json:"history"`
	UserInput    string        `json:"userInput"`
	IsCorrection bool          `json:"isCorrection"`
	CorrectThing string        `json:"correctThing"`
}

type historyItem struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type chatResponse struct {
	Question    string `json:"question"`
	IsGuess     bool   `json:"isGuess"`
	FinalAnswer string `json:"finalAnswer,omitempty"`
}

// ── Gemini REST API types ─────────────────────────────────────────────────────

type geminiRequest struct {
	SystemInstruction *systemInstruction `json:"system_instruction,omitempty"`
	Contents          []content          `json:"contents"`
}

type systemInstruction struct {
	Parts []part `json:"parts"`
}

type content struct {
	Role  string `json:"role"`
	Parts []part `json:"parts"`
}

type part struct {
	Text string `json:"text"`
}

type geminiResponse struct {
	Candidates []struct {
		Content content `json:"content"`
	} `json:"candidates"`
}

// ── Handler ──────────────────────────────────────────────────────────────────

// Handler is the Vercel serverless entry point.
func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSON(w, chatResponse{Question: "SYSTEM ERROR: Missing API Key."})
		return
	}

	var req frontendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, chatResponse{Question: "SERVER ERROR: Invalid request body."})
		return
	}

	// Build the prompt text for the new user turn
	var prompt string
	switch {
	case req.IsCorrection:
		histJSON, _ := json.Marshal(req.History)
		prompt = fmt.Sprintf(
			`I was thinking of "%s". Review our history: %s. Learn from this mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!"}`,
			req.CorrectThing, string(histJSON),
		)
	case req.UserInput != "":
		prompt = req.UserInput
	default:
		prompt = "Let's start!"
	}

	// Convert frontend history to Gemini content turns
	contents := make([]content, 0, len(req.History)+1)
	for _, h := range req.History {
		contents = append(contents, content{
			Role:  h.Role,
			Parts: []part{{Text: h.Text}},
		})
	}
	contents = append(contents, content{
		Role:  "user",
		Parts: []part{{Text: prompt}},
	})

	gReq := geminiRequest{
		SystemInstruction: &systemInstruction{Parts: []part{{Text: systemPrompt}}},
		Contents:          contents,
	}

	responseText, err := callGemini(apiKey, gReq)
	if err != nil {
		writeJSON(w, chatResponse{Question: "SERVER ERROR: " + err.Error()})
		return
	}

	// Correction flow — frontend only checks for errors, not the body
	if req.IsCorrection {
		writeJSON(w, map[string]bool{"reset": true})
		return
	}

	// Strip any accidental markdown fences Gemini may add
	responseText = strings.TrimPrefix(responseText, "```json")
	responseText = strings.TrimSuffix(responseText, "```")
	responseText = strings.TrimSpace(responseText)

	var resp chatResponse
	if err := json.Unmarshal([]byte(responseText), &resp); err != nil {
		writeJSON(w, chatResponse{Question: "SERVER ERROR: Failed to parse AI response: " + responseText})
		return
	}

	writeJSON(w, resp)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func callGemini(apiKey string, req geminiRequest) (string, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	resp, err := http.Post(geminiURL+"?key="+apiKey, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("HTTP request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Gemini API %d: %s", resp.StatusCode, string(respBody))
	}

	var gResp geminiResponse
	if err := json.Unmarshal(respBody, &gResp); err != nil {
		return "", fmt.Errorf("parse Gemini response: %w", err)
	}

	if len(gResp.Candidates) == 0 || len(gResp.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty response from Gemini")
	}

	return gResp.Candidates[0].Content.Parts[0].Text, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	json.NewEncoder(w).Encode(v)
}
