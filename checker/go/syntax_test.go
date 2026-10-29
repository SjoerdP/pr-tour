package main

import (
	"bytes"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
)

func loadCheckInput(t *testing.T) CheckInput {
	t.Helper()
	raw, err := os.ReadFile("testdata/check-input.json")
	if err != nil {
		t.Fatal(err)
	}
	var in CheckInput
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func findLink(t *testing.T, out CheckOutput, from, to string) Link {
	t.Helper()
	for _, l := range out.Links["F1"] {
		if l.From == from && l.To == to {
			return l
		}
	}
	t.Fatalf("no link %s -> %s in %+v", from, to, out.Links["F1"])
	return Link{}
}

func hasProblem(out CheckOutput, parts ...string) bool {
	for _, p := range out.Problems {
		ok := true
		for _, s := range parts {
			ok = ok && strings.Contains(p, s)
		}
		if ok {
			return true
		}
	}
	return false
}

func TestCheckSyntax(t *testing.T) {
	out, err := checkSyntax("testdata/flow", loadCheckInput(t))
	if err != nil {
		t.Fatal(err)
	}
	if out.EngineVersion != runtime.Version() {
		t.Errorf("engineVersion %q", out.EngineVersion)
	}
	golden := out
	golden.EngineVersion = "" // depends on the toolchain
	compareGolden(t, "check-syntax.json", golden)

	if out.Engine != "go-syntax" || out.Degraded {
		t.Errorf("engine %q degraded %v", out.Engine, out.Degraded)
	}
	for _, id := range []string{"S1", "S2", "S3", "S4", "S6"} {
		a := out.Steps[id].Anchor
		if a == nil || a.Source != "symbol" {
			t.Errorf("%s anchor %+v, want source symbol", id, a)
		}
	}
	if a := out.Steps["S5"].Anchor; a == nil || a.Name != "Max" || a.Source != "range" {
		t.Errorf("S5 anchor %+v", a)
	}
	if !hasProblem(out, "S5", "Nope") {
		t.Errorf("no problem naming Nope: %v", out.Problems)
	}
	if _, ok := out.Steps["S7"]; !ok || out.Steps["S7"].Anchor != nil {
		t.Errorf("S7 %+v", out.Steps["S7"])
	}
	if !hasProblem(out, "S7", "missing/gone.go") {
		t.Errorf("no problem naming the missing file: %v", out.Problems)
	}

	if l := findLink(t, out, "S1", "S2"); l.How != "register" || l.Check != "name-match" || l.Line != 23 {
		t.Errorf("S1->S2 %+v", l)
	}
	if l := findLink(t, out, "S2", "S3"); l.Check != "name-match" || l.Line != 19 || l.Note == "" {
		t.Errorf("S2->S3 %+v", l)
	}
	if l := findLink(t, out, "S4", "S3"); l.Check != "not-found" {
		t.Errorf("S4->S3 %+v", l)
	}
	for _, l := range out.Links["F1"] {
		if l.Source == "code" {
			t.Errorf("code link in syntax mode: %+v", l)
		}
	}

	marks := out.Steps["S3"].Marks
	want := []Mark{
		{Line: 20, Kind: "db-write", Label: "insert order", Source: "both"},
		{Line: 21, Kind: "db-write", Label: "returns early", Source: "claude"},
		{Line: 23, Kind: "async", Source: "code"},
	}
	if len(marks) != len(want) {
		t.Fatalf("S3 marks %+v", marks)
	}
	for i := range want {
		if marks[i] != want[i] {
			t.Errorf("mark %d = %+v, want %+v", i, marks[i], want[i])
		}
	}
	if !hasProblem(out, "S3", "40") {
		t.Errorf("no problem for the line outside the function: %v", out.Problems)
	}
	if m := out.Steps["S8"].Marks; len(m) != 1 || m[0] != (Mark{Line: 61, Kind: "async", Source: "code"}) {
		t.Errorf("S8 marks %+v", m)
	}
	if l := findLink(t, out, "S3", "S8"); l.How != "service" || l.Check != "unchecked" || l.Line != 21 {
		t.Errorf("S3->S8 %+v", l)
	}
	for id, s := range out.Steps {
		if len(s.CallSites) != 0 {
			t.Errorf("%s has call sites in syntax mode", id)
		}
	}
}

func TestAnchorSymbolExact(t *testing.T) {
	g, err := loadGoFile("testdata/flow", "service/service.go")
	if err != nil {
		t.Fatal(err)
	}
	a, _ := anchorStep(g, CheckStep{ID: "X", Symbol: "Run", StartLine: 57, EndLine: 58})
	if a.Name != "Run" || a.StartLine != 54 || a.Source != "symbol" {
		t.Errorf("Run: %+v", a)
	}
	a, _ = anchorStep(g, CheckStep{ID: "X", Symbol: "Job.Run", StartLine: 54, EndLine: 55})
	if a.Name != "Job.Run" || a.StartLine != 57 {
		t.Errorf("Job.Run: %+v", a)
	}
}

func TestCheckSyntaxEscapingPath(t *testing.T) {
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "S1", File: "../flow/api/api.go", StartLine: 1, EndLine: 2},
	}}}}
	out, err := checkSyntax("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Steps["S1"].Anchor != nil || !hasProblem(out, "S1", "outside") {
		t.Errorf("%+v %v", out.Steps["S1"], out.Problems)
	}
}

func TestRunCheckSyntaxOnly(t *testing.T) {
	raw, _ := os.ReadFile("testdata/check-input.json")
	var stdout, stderr bytes.Buffer
	code := run([]string{"check", "--root", "testdata/flow", "--syntax-only"}, bytes.NewReader(raw), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	var out CheckOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil || out.Engine != "go-syntax" {
		t.Errorf("%v %+v", err, out)
	}
}

// A calls entry naming a symbol that was not found still reaches the step
// (Claude's link is never dropped). It is checked by the name of the
// function the step is anchored on, here Max, which PlaceWrapped does not
// call.
func TestCheckSyntaxCallsEntryToMissingSymbol(t *testing.T) {
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "service/service.go", Symbol: "OrderService.PlaceWrapped", StartLine: 31, EndLine: 33,
			Calls: []Call{{Symbol: "Nope", File: "service/service.go", Line: 32}}},
		{ID: "B", File: "service/service.go", Symbol: "Nope", StartLine: 46, EndLine: 48},
	}}}}
	out, err := checkSyntax("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if a := out.Steps["B"].Anchor; a == nil || a.Name != "Max" || a.Source != "range" {
		t.Errorf("B anchor %+v", a)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "not-found" || l.Source != "claude" || l.Line != 32 {
		t.Errorf("A->B %+v", l)
	}
}

// A link into a step that is no function (a SQL file, a type) cannot be
// checked: it is unchecked, never matched by an empty name against a go
// statement.
func TestCheckSyntaxLinkToNonFunctionStep(t *testing.T) {
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "S1", File: "service/service.go", Symbol: "OrderService.Place", StartLine: 19, EndLine: 25},
		{ID: "S2", File: "migrations/001_orders.sql", StartLine: 1, EndLine: 5,
			From: &From{Step: 1, Line: 20, How: "call"}},
		{ID: "S3", File: "service/service.go", Symbol: "OrderService", StartLine: 13, EndLine: 16,
			From: &From{Step: 1, Line: 20, How: "call"}},
	}}}}
	out, err := checkSyntax("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	for _, to := range []string{"S2", "S3"} {
		l := findLink(t, out, "S1", to)
		if l.Check != "unchecked" || l.How != "call" || l.Line != 20 || l.Note != "the called step is not a function" {
			t.Errorf("S1->%s %+v", to, l)
		}
	}
}

// A go statement has no name and never matches one.
func TestMatchSiteSkipsGoStatements(t *testing.T) {
	sites := []site{{Line: 3, IsGo: true}}
	if s, ok := matchSite(sites, "", 1); ok {
		t.Errorf("matched %+v", s)
	}
}

// Syntax mode checks nothing by position: no step carries callSites.
func TestCheckSyntaxOmitsCallSites(t *testing.T) {
	out, err := checkSyntax("testdata/flow", loadCheckInput(t))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "callSites") {
		t.Errorf("callSites in syntax output: %s", raw)
	}
}

// Calls with explicit instantiation or a parenthesised callee are calls.
func TestCheckSyntaxGenericAndParenCalls(t *testing.T) {
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "service/generic.go", Symbol: "UseGenerics", StartLine: 11, EndLine: 15,
			Calls: []Call{{Symbol: "Max", File: "service/service.go", Line: 14}}},
		{ID: "B", File: "service/service.go", Symbol: "Max", StartLine: 46, EndLine: 51},
		{ID: "C", File: "service/generic.go", Symbol: "Paren", StartLine: 17, EndLine: 19,
			Calls: []Call{{Symbol: "Run", File: "service/service.go", Line: 18}}},
		{ID: "D", File: "service/service.go", Symbol: "Run", StartLine: 54, EndLine: 55},
	}}}}
	out, err := checkSyntax("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "name-match" || l.How != "call" || l.Line != 14 {
		t.Errorf("A->B %+v", l)
	}
	if l := findLink(t, out, "C", "D"); l.Check != "name-match" || l.How != "call" || l.Line != 18 {
		t.Errorf("C->D %+v", l)
	}
}
