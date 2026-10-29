package main

// CheckerVersion is bumped when the JSON contract or the analysis changes.
// Keep in sync with CHECKER_VERSION in src/server/analysis/contract.ts.
const CheckerVersion = 1

// FileLines lists head-side changed lines of one file.
type FileLines struct {
	Path  string `json:"path"`
	Lines []int  `json:"lines"`
}

type FunctionsInput struct {
	Files []FileLines `json:"files"`
}

type FuncInfo struct {
	File      string `json:"file"`
	Name      string `json:"name"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
}

type FunctionsOutput struct {
	Version   int        `json:"version"`
	Functions []FuncInfo `json:"functions"`
	// Problems names the files that were skipped (unparsable, or outside
	// the root).
	Problems []string `json:"problems,omitempty"`
}

type Call struct {
	Symbol string `json:"symbol"`
	File   string `json:"file"`
	Line   int    `json:"line"`
}

type From struct {
	Step int    `json:"step"`
	Line int    `json:"line"`
	How  string `json:"how"` // call | service | event
}

type SideEffect struct {
	Kind  string `json:"kind"` // db-write | event | external-call
	Label string `json:"label"`
	Line  int    `json:"line,omitempty"`
}

type CheckStep struct {
	ID          string       `json:"id"`
	File        string       `json:"file"`
	Symbol      string       `json:"symbol,omitempty"`
	StartLine   int          `json:"startLine"`
	EndLine     int          `json:"endLine"`
	Calls       []Call       `json:"calls"`
	From        *From        `json:"from,omitempty"`
	SideEffects []SideEffect `json:"sideEffects"`
}

type CheckFlow struct {
	ID    string      `json:"id"`
	Steps []CheckStep `json:"steps"`
}

type CheckInput struct {
	Flows []CheckFlow `json:"flows"`
}

type Anchor struct {
	Name      string `json:"name"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Source    string `json:"source"` // symbol | incoming-link | range
}

type Mark struct {
	Line   int    `json:"line"`
	Kind   string `json:"kind"` // db-write | event | external-call | async
	Label  string `json:"label,omitempty"`
	Source string `json:"source"` // code | claude | both
}

type ToRef struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

type CallSite struct {
	Line   int    `json:"line"`
	Col    int    `json:"col"`
	EndCol int    `json:"endCol"`
	To     ToRef  `json:"to"`
	ToStep string `json:"toStep,omitempty"`
}

type Link struct {
	From   string   `json:"from"`
	To     string   `json:"to"`
	Line   int      `json:"line"`
	How    string   `json:"how"` // call | register | service | event
	Via    []string `json:"via,omitempty"`
	Source string   `json:"source"` // claude | code | both
	Check  string   `json:"check"`  // proven | name-match | not-found | conflict | unchecked
	Note   string   `json:"note,omitempty"`
	Reason string   `json:"reason,omitempty"`
}

type StepResult struct {
	Anchor *Anchor `json:"anchor,omitempty"`
	Marks  []Mark  `json:"marks"`
	// CallSites is set only for steps whose function was type-checked: nil
	// (left out of the JSON) means not checked, empty means no calls.
	CallSites []CallSite `json:"callSites,omitzero"`
}

type CheckOutput struct {
	Version       int                   `json:"version"`
	Engine        string                `json:"engine"` // go-types | go-syntax
	EngineVersion string                `json:"engineVersion"`
	Degraded      bool                  `json:"degraded"`
	Steps         map[string]StepResult `json:"steps"`
	Links         map[string][]Link     `json:"links"` // by flow id
	Problems      []string              `json:"problems"`
}
