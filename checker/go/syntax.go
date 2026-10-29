package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// goFunc is a function or method of a parsed file. Lines are 1-based and the
// doc comment is not part of the range.
type goFunc struct {
	Name       string
	Start, End int
	Decl       *ast.FuncDecl
}

type goFile struct {
	Path  string
	Fset  *token.FileSet
	AST   *ast.File
	Funcs []goFunc
}

// site is a call or a reference by name inside a function.
type site struct {
	Name   string // last name: "Create" for h.Create
	Line   int
	Col    int // 1-based, in bytes
	EndCol int
	IsCall bool
	IsGo   bool // a go statement (no name)
}

// safeJoin joins a slash path to root and refuses paths that leave it.
func safeJoin(root, rel string) (string, bool) {
	p := filepath.FromSlash(rel)
	if rel == "" || !filepath.IsLocal(p) {
		return "", false
	}
	return filepath.Join(root, p), true
}

// loadGoFile parses one file (syntax only) and lists its functions.
func loadGoFile(root, rel string) (*goFile, error) {
	full, ok := safeJoin(root, rel)
	if !ok {
		return nil, fmt.Errorf("path %s is outside the repository", rel)
	}
	if _, err := os.Stat(full); err != nil {
		return nil, fmt.Errorf("file %s not found", rel)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, full, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, fmt.Errorf("cannot parse %s", rel)
	}
	gf := &goFile{Path: rel, Fset: fset, AST: f}
	for _, d := range f.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok {
			gf.Funcs = append(gf.Funcs, goFunc{
				Name: funcName(fn), Decl: fn,
				Start: fset.Position(fn.Pos()).Line, End: fset.Position(fn.End()).Line,
			})
		}
	}
	return gf, nil
}

func (g *goFile) funcByName(name string) *goFunc {
	for i := range g.Funcs {
		if g.Funcs[i].Name == name {
			return &g.Funcs[i]
		}
	}
	return nil
}

func (g *goFile) funcAround(line int) *goFunc {
	for i := range g.Funcs {
		if line >= g.Funcs[i].Start && line <= g.Funcs[i].End {
			return &g.Funcs[i]
		}
	}
	return nil
}

// anchorStep anchors a step in a parsed file: the symbol exactly, then the
// function around startLine, then around endLine. The incoming-link rule only
// applies in typed mode. The second result is a problem line, or "".
func anchorStep(g *goFile, st CheckStep) (*Anchor, string) {
	mk := func(f *goFunc, src string) *Anchor {
		return &Anchor{Name: f.Name, StartLine: f.Start, EndLine: f.End, Source: src}
	}
	if st.Symbol != "" {
		if f := g.funcByName(st.Symbol); f != nil {
			return mk(f, "symbol"), ""
		}
	}
	f := g.funcAround(st.StartLine)
	if f == nil {
		f = g.funcAround(st.EndLine)
	}
	if st.Symbol == "" {
		if f == nil {
			return nil, ""
		}
		return mk(f, "range"), ""
	}
	if f == nil {
		return nil, fmt.Sprintf("step %s: symbol %s not found in %s; no function around lines %d-%d", st.ID, st.Symbol, g.Path, st.StartLine, st.EndLine)
	}
	return mk(f, "range"), fmt.Sprintf("step %s: symbol %s not found in %s; anchored by range to %s", st.ID, st.Symbol, g.Path, f.Name)
}

// findSites lists every call and every by-name reference (a selector or an
// identifier that is not itself called) inside the function, in source order.
func findSites(g *goFile, fn *goFunc) []site {
	var sites []site
	if fn.Decl.Body == nil {
		return sites
	}
	skip := map[ast.Node]bool{} // call targets, counted as calls already
	add := func(n ast.Node, name string, isCall bool, isGo bool) {
		p, e := g.Fset.Position(n.Pos()), g.Fset.Position(n.End())
		sites = append(sites, site{Name: name, Line: p.Line, Col: p.Column, EndCol: e.Column, IsCall: isCall, IsGo: isGo})
	}
	ast.Inspect(fn.Decl.Body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.GoStmt:
			// The mark comes from the statement itself, whatever it calls.
			p := g.Fset.Position(x.Pos())
			sites = append(sites, site{Line: p.Line, Col: p.Column, IsGo: true})
		case *ast.CallExpr:
			switch f := x.Fun.(type) {
			case *ast.Ident:
				skip[f] = true
				add(f, f.Name, true, false)
			case *ast.SelectorExpr:
				skip[f] = true
				add(f.Sel, f.Sel.Name, true, false)
			}
			// A bare function name passed as an argument is a reference.
			for _, arg := range x.Args {
				if id, ok := arg.(*ast.Ident); ok {
					add(id, id.Name, false, false)
				}
			}
		case *ast.SelectorExpr:
			if !skip[x] {
				add(x.Sel, x.Sel.Name, false, false)
			}
		}
		return true
	})
	sort.SliceStable(sites, func(i, j int) bool {
		if sites[i].Line != sites[j].Line {
			return sites[i].Line < sites[j].Line
		}
		return sites[i].Col < sites[j].Col
	})
	return sites
}

func lastName(sym string) string {
	if i := strings.LastIndex(sym, "."); i >= 0 {
		return sym[i+1:]
	}
	return sym
}

// matchSite finds the call or reference to name; a site on wantLine wins,
// calls win over references, then the first in source order.
func matchSite(sites []site, name string, wantLine int) (site, bool) {
	var best site
	rank := -1
	for _, s := range sites {
		if s.Name != name {
			continue
		}
		r := 0
		if s.IsCall {
			r = 1
		}
		if s.Line == wantLine {
			r += 2
		}
		if r > rank {
			best, rank = s, r
		}
	}
	return best, rank >= 0
}

// stepMarks gives the marks of an anchored step: side-effect lines (checked
// for a call on the line) and go statements. Dropped lines become problems.
func stepMarks(st CheckStep, a *Anchor, sites []site) ([]Mark, []string) {
	marks := []Mark{}
	var problems []string
	callLines := map[int]bool{}
	for _, s := range sites {
		if s.IsCall {
			callLines[s.Line] = true
		}
		if s.IsGo {
			marks = append(marks, Mark{Line: s.Line, Kind: "async", Source: "code"})
		}
	}
	for _, se := range st.SideEffects {
		if se.Line == 0 {
			continue
		}
		if se.Line < a.StartLine || se.Line > a.EndLine {
			problems = append(problems, fmt.Sprintf("step %s: side effect line %d (%s) is outside %s (lines %d-%d); dropped", st.ID, se.Line, se.Kind, a.Name, a.StartLine, a.EndLine))
			continue
		}
		src := "claude"
		if callLines[se.Line] {
			src = "both"
		}
		marks = append(marks, Mark{Line: se.Line, Kind: se.Kind, Label: se.Label, Source: src})
	}
	sort.SliceStable(marks, func(i, j int) bool {
		if marks[i].Line != marks[j].Line {
			return marks[i].Line < marks[j].Line
		}
		return marks[i].Kind < marks[j].Kind
	})
	return marks, problems
}

type stepState struct {
	step   CheckStep
	anchor *Anchor
	sites  []site
}

// checkSyntax checks a tour by syntax only: it anchors steps, marks lines and
// checks Claude's links by name. It never finds links Claude did not give.
func checkSyntax(root string, in CheckInput) (CheckOutput, error) {
	out := CheckOutput{
		Version: CheckerVersion, Engine: "go-syntax", EngineVersion: runtime.Version(),
		Steps: map[string]StepResult{}, Links: map[string][]Link{}, Problems: []string{},
	}
	files := map[string]*goFile{}
	fileErr := map[string]error{}
	load := func(rel string) (*goFile, error) {
		if g, ok := files[rel]; ok {
			return g, nil
		}
		if err, ok := fileErr[rel]; ok {
			return nil, err
		}
		g, err := loadGoFile(root, rel)
		if err != nil {
			fileErr[rel] = err
			return nil, err
		}
		files[rel] = g
		return g, nil
	}
	for _, flow := range in.Flows {
		states := make([]*stepState, len(flow.Steps))
		for i, st := range flow.Steps {
			ss := &stepState{step: st}
			states[i] = ss
			res := StepResult{Marks: []Mark{}, CallSites: []CallSite{}}
			if strings.HasSuffix(st.File, ".go") {
				g, err := load(st.File)
				if err != nil {
					out.Problems = append(out.Problems, fmt.Sprintf("step %s: %v", st.ID, err))
				} else {
					a, problem := anchorStep(g, st)
					if problem != "" {
						out.Problems = append(out.Problems, problem)
					}
					if a != nil {
						ss.anchor = a
						ss.sites = findSites(g, g.funcByName(a.Name))
						var mp []string
						res.Anchor = a
						res.Marks, mp = stepMarks(st, a, ss.sites)
						out.Problems = append(out.Problems, mp...)
					}
				}
			}
			out.Steps[st.ID] = res
		}
		out.Links[flow.ID] = syntaxLinks(states)
	}
	return out, nil
}

// syntaxLinks checks the links Claude gave in one flow: each step's from, then
// each calls entry that names another step of the flow.
func syntaxLinks(states []*stepState) []Link {
	links := []Link{}
	seen := map[[2]string]bool{}
	check := func(caller, callee *stepState, claimed int, how string) {
		key := [2]string{caller.step.ID, callee.step.ID}
		if seen[key] {
			return
		}
		seen[key] = true
		l := Link{From: caller.step.ID, To: callee.step.ID, Line: claimed, How: how, Source: "claude"}
		if how == "service" || how == "event" {
			l.Check = "unchecked"
			links = append(links, l)
			return
		}
		l.How = "call"
		if caller.anchor == nil {
			l.Check = "unchecked"
			l.Note = "calling step has no anchor"
			links = append(links, l)
			return
		}
		name := lastName(callee.step.Symbol)
		if callee.anchor != nil {
			name = lastName(callee.anchor.Name)
		}
		s, ok := matchSite(caller.sites, name, claimed)
		if !ok {
			l.Check = "not-found"
			links = append(links, l)
			return
		}
		l.Check = "name-match"
		if !s.IsCall {
			l.How = "register"
		}
		if claimed != s.Line {
			if claimed > 0 {
				l.Note = fmt.Sprintf("tour says line %d", claimed)
			}
			l.Line = s.Line
		}
		links = append(links, l)
	}
	for i, ss := range states {
		if f := ss.step.From; f != nil && f.Step >= 1 && f.Step <= len(states) && f.Step-1 != i {
			check(states[f.Step-1], ss, f.Line, f.How)
		}
	}
	for _, ss := range states {
		for _, c := range ss.step.Calls {
			for _, t := range states {
				if t == ss || t.step.File != c.File || !stepIsNamed(t, c.Symbol) {
					continue
				}
				check(ss, t, c.Line, "call")
			}
		}
	}
	sort.SliceStable(links, func(i, j int) bool {
		a, b := links[i], links[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.To < b.To
	})
	return links
}

func stepIsNamed(s *stepState, sym string) bool {
	if s.anchor != nil {
		return s.anchor.Name == sym
	}
	return s.step.Symbol == sym
}
