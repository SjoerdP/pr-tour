package main

import (
	"bytes"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
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
