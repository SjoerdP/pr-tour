package main

import (
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "regenerate golden files")

// compareGolden checks v against testdata/golden/<name>; -update rewrites it.
func compareGolden(t *testing.T, name string, v any) {
	t.Helper()
	got, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	path := "testdata/golden/" + name
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Errorf("%s differs from golden (run go test -update to regenerate)\ngot:\n%s\nwant:\n%s", name, got, want)
	}
}

func TestFunctions(t *testing.T) {
	in := FunctionsInput{Files: []FileLines{
		// Input order is deliberately not sorted.
		{Path: "service/service.go", Lines: []int{20, 32, 46, 54, 57, 58}},
		{Path: "api/integration.go", Lines: []int{5}},
	}}
	out, err := listFunctions("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Version != CheckerVersion {
		t.Errorf("version = %d, want %d", out.Version, CheckerVersion)
	}
	compareGolden(t, "functions.json", out)

	names := map[string]bool{}
	for _, f := range out.Functions {
		names[f.Name] = true
	}
	for _, want := range []string{"OrderService.Place", "OrderService.PlaceWrapped", "Max", "Run", "Job.Run", "IntegrationOnly"} {
		if !names[want] {
			t.Errorf("missing function %q in %v", want, names)
		}
	}
	for i := 1; i < len(out.Functions); i++ {
		a, b := out.Functions[i-1], out.Functions[i]
		if a.File > b.File || (a.File == b.File && a.StartLine > b.StartLine) {
			t.Errorf("not sorted by file then startLine: %v before %v", a, b)
		}
	}
}

func TestFunctionsIgnoresDocComment(t *testing.T) {
	// Line 18 is the doc comment of OrderService.Place.
	in := FunctionsInput{Files: []FileLines{{Path: "service/service.go", Lines: []int{18}}}}
	out, err := listFunctions("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Functions) != 0 {
		t.Errorf("got %v, want none", out.Functions)
	}
}

func TestFunctionsMissingFile(t *testing.T) {
	in := FunctionsInput{Files: []FileLines{{Path: "nope.go", Lines: []int{1}}}}
	out, err := listFunctions("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Functions) != 0 || len(out.Problems) != 1 || !strings.Contains(out.Problems[0], "nope.go") {
		t.Errorf("want nope.go skipped with a problem, got %+v", out)
	}
}

func TestRun(t *testing.T) {
	var so, se strings.Builder
	if code := run([]string{"version"}, strings.NewReader(""), &so, &se); code != 0 || so.String() != "1\n" {
		t.Errorf("version: code %d out %q", code, so.String())
	}
	so.Reset()
	if code := run([]string{"bogus"}, strings.NewReader(""), &so, &se); code != 2 || so.Len() != 0 || se.Len() == 0 {
		t.Errorf("bogus: code %d out %q err %q", code, so.String(), se.String())
	}
	so.Reset()
	se.Reset()
	if code := run([]string{"functions", "--root", "testdata/flow"}, strings.NewReader("{bad"), &so, &se); code != 1 || so.Len() != 0 || se.Len() == 0 {
		t.Errorf("bad json: code %d out %q err %q", code, so.String(), se.String())
	}
	if code := run([]string{"functions"}, strings.NewReader("{}"), &so, &se); code != 2 {
		t.Errorf("no root: code %d", code)
	}
}

// A generic receiver is named without its type parameters.
func TestFunctionsGenericReceiver(t *testing.T) {
	in := FunctionsInput{Files: []FileLines{{Path: "service/generic.go", Lines: []int{8}}}}
	out, err := listFunctions("testdata/flow", in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Functions) != 1 || out.Functions[0].Name != "List.Add" {
		t.Errorf("got %+v", out.Functions)
	}
}

// A file that does not parse, or that leaves the root, is skipped and named
// in problems; the other files are still listed.
func TestFunctionsSkipsBadFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/bad.go", []byte("package x\nfunc {"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/good.go", []byte("package x\n\nfunc Good() {\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	in := FunctionsInput{Files: []FileLines{
		{Path: "bad.go", Lines: []int{2}},
		{Path: "../escape.go", Lines: []int{1}},
		{Path: "good.go", Lines: []int{3}},
	}}
	out, err := listFunctions(dir, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Functions) != 1 || out.Functions[0].Name != "Good" {
		t.Errorf("functions %+v", out.Functions)
	}
	if len(out.Problems) != 2 || !strings.Contains(out.Problems[0], "bad.go") || !strings.Contains(out.Problems[1], "../escape.go") {
		t.Errorf("problems %v", out.Problems)
	}
}
