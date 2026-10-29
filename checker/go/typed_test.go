package main

import (
	"bytes"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// typedEnv sets the environment the server runs the checker with: the
// analysed project is loaded without network and without changing go.mod.
func typedEnv(t *testing.T) {
	t.Setenv("GOPROXY", "off")
	t.Setenv("GOFLAGS", "-mod=readonly")
	t.Setenv("GOTOOLCHAIN", "local")
}

func loadInputFile(t *testing.T, path string) CheckInput {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var in CheckInput
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	return in
}

func linksFrom(out CheckOutput, from string) []Link {
	var ls []Link
	for _, l := range out.Links["F1"] {
		if l.From == from {
			ls = append(ls, l)
		}
	}
	return ls
}

func TestCheckTyped(t *testing.T) {
	typedEnv(t)
	in := loadInputFile(t, "testdata/check-input-typed.json")
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Engine != "go-types" || out.Degraded {
		t.Errorf("engine %q degraded %v", out.Engine, out.Degraded)
	}
	if !strings.HasSuffix(out.EngineVersion, " "+runtime.Version()) {
		t.Errorf("engineVersion %q", out.EngineVersion)
	}
	golden := out
	golden.EngineVersion = "" // depends on the toolchain
	compareGolden(t, "check-typed.json", golden)

	// Through the interface; the second implementation is no step.
	if l := findLink(t, out, "S2", "S3"); l.Check != "proven" || l.Source != "both" || l.Line != 19 || l.Note != "tour says line 18" {
		t.Errorf("S2->S3 %+v", l)
	}
	if ls := linksFrom(out, "S2"); len(ls) != 1 {
		t.Errorf("links from S2 %+v", ls)
	}

	// Registration of a method value, and of a closure in Routes.
	if l := findLink(t, out, "S1", "S2"); l.Check != "proven" || l.How != "register" || l.Line != 23 || l.Source != "both" {
		t.Errorf("S1->S2 %+v", l)
	}
	// Line 24 names two functions of api.go (Router.Handle, Handler.ping):
	// no incoming-link anchor, the range anchor stays.
	if a := out.Steps["S14"].Anchor; a == nil || a.Name != "Routes" || a.Source != "range" {
		t.Errorf("S14 anchor %+v", a)
	}
	if l := findLink(t, out, "S1", "S14"); l.Check != "proven" || l.How != "register" || l.Line != 24 {
		t.Errorf("S1->S14 %+v", l)
	}
	for _, l := range out.Links["F1"] {
		if l.From == "S14" {
			t.Errorf("code link from a second step on Routes: %+v", l)
		}
	}

	// Through one thin wrapper.
	if l := findLink(t, out, "S4", "S9"); l.Check != "proven" || l.Line != 32 || len(l.Via) != 1 || l.Via[0] != "OrderService.place" {
		t.Errorf("S4->S9 %+v", l)
	}
	if l := findLink(t, out, "S4", "S3"); l.Check != "not-found" || l.Source != "claude" {
		t.Errorf("S4->S3 %+v", l)
	}
	if !hasProblem(out, "S4", "S3", "OrderService.place") {
		t.Errorf("no problem for the call that lands elsewhere: %v", out.Problems)
	}

	// Standard library calls and field references give nothing.
	for _, cs := range out.Steps["S2"].CallSites {
		if cs.Line == 18 {
			t.Errorf("call site into the standard library: %+v", cs)
		}
	}
	if ls := linksFrom(out, "S10"); len(ls) != 0 {
		t.Errorf("links from notify %+v", ls)
	}
	if cs := out.Steps["S10"].CallSites; len(cs) != 0 {
		t.Errorf("call sites in notify %+v", cs)
	}

	// Discovery.
	if l := findLink(t, out, "S3", "S10"); l.Source != "code" || l.Check != "proven" || l.Line != 23 || l.How != "call" {
		t.Errorf("S3->S10 %+v", l)
	}
	if l := findLink(t, out, "S3", "S9"); l.Source != "code" || l.Check != "proven" || l.Line != 20 {
		t.Errorf("S3->S9 %+v", l)
	}
	if l := findLink(t, out, "S3", "S8"); l.Check != "unchecked" || l.How != "service" {
		t.Errorf("S3->S8 %+v", l)
	}

	// Call sites by position.
	want := CallSite{Line: 19, Col: 18, EndCol: 23, To: ToRef{File: "service/service.go", Line: 19}, ToStep: "S3"}
	found := false
	for _, cs := range out.Steps["S2"].CallSites {
		found = found || cs == want
	}
	if !found {
		t.Errorf("S2 call sites %+v, want %+v", out.Steps["S2"].CallSites, want)
	}
	pingSite := CallSite{Line: 24, Col: 31, EndCol: 35, To: ToRef{File: "api/api.go", Line: 27}}
	found = false
	for _, cs := range out.Steps["S1"].CallSites {
		found = found || cs == pingSite
	}
	if !found {
		t.Errorf("S1 call sites %+v, want the closure's call %+v", out.Steps["S1"].CallSites, pingSite)
	}

	// Generated code: Claude's link is checked, code adds none.
	if l := findLink(t, out, "S11", "S13"); l.Check != "proven" || l.Source != "both" {
		t.Errorf("S11->S13 %+v", l)
	}
	for _, l := range out.Links["F1"] {
		if l.To == "S13" && l.Source == "code" {
			t.Errorf("code link into generated code: %+v", l)
		}
	}

	// Same input, same bytes.
	first, _ := json.Marshal(out)
	for i := 0; i < 2; i++ {
		again, err := checkTyped("testdata/flow", in)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(again)
		if !bytes.Equal(first, b) {
			t.Fatalf("run %d differs:\n%s\n%s", i+2, first, b)
		}
	}
}

func TestCheckTypedIncomingLink(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "service/service.go", Symbol: "OrderService.PlaceWrapped", StartLine: 31, EndLine: 33,
			Calls: []Call{{Symbol: "OrderService.plac", File: "service/service.go", Line: 32}}},
		{ID: "B", File: "service/service.go", Symbol: "OrderService.plac", StartLine: 1, EndLine: 2},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	a := out.Steps["B"].Anchor
	if a == nil || a.Name != "OrderService.place" || a.Source != "incoming-link" || a.StartLine != 35 || a.EndLine != 37 {
		t.Errorf("B anchor %+v", a)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "proven" || l.Line != 32 {
		t.Errorf("A->B %+v", l)
	}
	if !hasProblem(out, "B", "OrderService.plac", "incoming link") {
		t.Errorf("problems %v", out.Problems)
	}
}

func TestCheckTypedIncomingLinkNoSymbol(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "service/service.go", Symbol: "OrderService.PlaceWrapped", StartLine: 31, EndLine: 33},
		{ID: "B", File: "service/service.go", StartLine: 1, EndLine: 2, From: &From{Step: 1, Line: 32, How: "call"}},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	a := out.Steps["B"].Anchor
	if a == nil || a.Name != "OrderService.place" || a.Source != "incoming-link" || a.StartLine != 35 || a.EndLine != 37 {
		t.Errorf("B anchor %+v", a)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "proven" || l.Line != 32 {
		t.Errorf("A->B %+v", l)
	}
	if !hasProblem(out, "step B: no symbol", "incoming link to OrderService.place") {
		t.Errorf("problems %v", out.Problems)
	}
}

func TestLoaderEnvForcesOffline(t *testing.T) {
	t.Setenv("GOPROXY", "https://proxy.example.com")
	t.Setenv("GOFLAGS", "-mod=mod")
	t.Setenv("GOTOOLCHAIN", "auto")
	env := loaderEnv(os.Environ())
	if len(env) < 3 {
		t.Fatalf("env %v", env)
	}
	tail := env[len(env)-3:]
	want := []string{"GOPROXY=off", "GOFLAGS=-mod=readonly", "GOTOOLCHAIN=local"}
	for i := range want {
		if tail[i] != want[i] {
			t.Fatalf("env ends with %v, want %v", tail, want)
		}
	}
}

func TestRunCheckTyped(t *testing.T) {
	typedEnv(t)
	raw, _ := os.ReadFile("testdata/check-input-typed.json")
	var stdout, stderr bytes.Buffer
	if code := run([]string{"check", "--root", "testdata/flow"}, bytes.NewReader(raw), &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	var out CheckOutput
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil || out.Engine != "go-types" {
		t.Errorf("%v %+v", err, out)
	}
}

func TestTypedPartial(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "good/good.go", Symbol: "Start", StartLine: 3, EndLine: 5,
			Calls: []Call{{Symbol: "Next", File: "good/good.go", Line: 4}}},
		{ID: "B", File: "good/good.go", Symbol: "Next", StartLine: 7, EndLine: 8},
		{ID: "C", File: "bad/bad.go", Symbol: "Run", StartLine: 3, EndLine: 5,
			Calls: []Call{{Symbol: "Finish", File: "bad/bad.go", Line: 4}}},
		{ID: "D", File: "bad/bad.go", Symbol: "Finish", StartLine: 7, EndLine: 10},
	}}}}
	out, err := checkTyped("testdata/broken", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Engine != "go-types" || !out.Degraded {
		t.Errorf("engine %q degraded %v", out.Engine, out.Degraded)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "proven" {
		t.Errorf("A->B %+v", l)
	}
	if l := findLink(t, out, "C", "D"); l.Check != "name-match" {
		t.Errorf("C->D %+v", l)
	}
	if !hasProblem(out, "example.com/broken/bad", "does not type-check") {
		t.Errorf("problems %v", out.Problems)
	}
	first, _ := json.Marshal(out)
	again, _ := checkTyped("testdata/broken", in)
	if b, _ := json.Marshal(again); !bytes.Equal(first, b) {
		t.Errorf("output differs between runs")
	}
}

func TestTypedMissingDep(t *testing.T) {
	typedEnv(t)
	start := time.Now()
	var stdout, stderr bytes.Buffer
	code := run([]string{"check", "--root", "testdata/missingdep"}, strings.NewReader(`{"flows":[]}`), &stdout, &stderr)
	if code != 3 {
		t.Errorf("exit %d, want 3", code)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout %q", stdout.String())
	}
	if stderr.Len() == 0 {
		t.Errorf("no error text on stderr")
	}
	if d := time.Since(start); d > 30*time.Second {
		t.Errorf("took %v", d)
	}
}

func TestTypedBuildTags(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "S12", File: "api/integration.go", Symbol: "IntegrationOnly", StartLine: 5, EndLine: 6},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if a := out.Steps["S12"].Anchor; a == nil || a.Name != "IntegrationOnly" || a.Source != "symbol" {
		t.Errorf("S12 anchor %+v", a)
	}
	if !hasProblem(out, "step S12", "api/integration.go", "not part of the normal build") {
		t.Errorf("problems %v", out.Problems)
	}
	if out.Degraded {
		t.Errorf("a file left out of the normal build must not degrade the run")
	}
}

// In typed mode too, a link into a step that is no function is unchecked.
func TestCheckTypedLinkToNonFunctionStep(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "S1", File: "service/service.go", Symbol: "OrderService.Place", StartLine: 19, EndLine: 25},
		{ID: "S2", File: "migrations/001_orders.sql", StartLine: 1, EndLine: 5,
			From: &From{Step: 1, Line: 20, How: "call"}},
		{ID: "S3", File: "service/service.go", Symbol: "OrderService", StartLine: 13, EndLine: 16,
			From: &From{Step: 1, Line: 20, How: "call"}},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	for _, to := range []string{"S2", "S3"} {
		l := findLink(t, out, "S1", to)
		if l.Check != "unchecked" || l.Line != 20 || l.Note != "the called step is not a function" {
			t.Errorf("S1->%s %+v", to, l)
		}
	}
	raw, _ := json.Marshal(out.Steps)
	var steps map[string]map[string]any
	_ = json.Unmarshal(raw, &steps)
	if _, ok := steps["S1"]["callSites"]; !ok {
		t.Errorf("typed step S1 has no callSites key: %s", raw)
	}
	for _, id := range []string{"S2", "S3"} {
		if _, ok := steps[id]["callSites"]; ok {
			t.Errorf("unchecked step %s has a callSites key: %s", id, raw)
		}
	}
}

// A typed step with no project calls says so with an empty list.
func TestCheckTypedEmptyCallSites(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "service/service.go", Symbol: "OrderService.notify", StartLine: 27, EndLine: 29},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(out.Steps["A"])
	if !strings.Contains(string(raw), `"callSites":[]`) {
		t.Errorf("A %s", raw)
	}
}

// An interface with two implementations that are both steps: Claude's link
// is proven to its target, the other gets its own code-found link.
func TestCheckTypedTwoImplementations(t *testing.T) {
	typedEnv(t)
	in := CheckInput{Flows: []CheckFlow{{ID: "F1", Steps: []CheckStep{
		{ID: "A", File: "api/api.go", Symbol: "Handler.Create", StartLine: 17, EndLine: 20,
			Calls: []Call{{Symbol: "OrderService.Place", File: "service/service.go", Line: 19}}},
		{ID: "B", File: "service/service.go", Symbol: "OrderService.Place", StartLine: 19, EndLine: 25},
		{ID: "C", File: "service/service.go", Symbol: "AuditOrders.Place", StartLine: 41, EndLine: 43},
	}}}}
	out, err := checkTyped("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if l := findLink(t, out, "A", "B"); l.Check != "proven" || l.Source != "both" || l.Line != 19 {
		t.Errorf("A->B %+v", l)
	}
	if l := findLink(t, out, "A", "C"); l.Check != "proven" || l.Source != "code" || l.Line != 19 || l.How != "call" {
		t.Errorf("A->C %+v", l)
	}
}
