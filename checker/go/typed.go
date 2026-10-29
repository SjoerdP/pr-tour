package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"

	"golang.org/x/tools/go/packages"
)

const loadMode = packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
	packages.NeedTypes | packages.NeedTypesInfo | packages.NeedDeps | packages.NeedImports

// funcInfo is a function or method declared in a project package that
// type-checked.
type funcInfo struct {
	File      string // slash path relative to the root
	Name      string // Receiver.Method or Function
	Line, End int
	Decl      *ast.FuncDecl
	Pkg       *packages.Package
	Generated bool
}

// tsite is a resolved call or reference to project functions in a function.
type tsite struct {
	Line, Col, EndCol int
	IsCall            bool
	Closure           bool        // a func literal passed to a call: lands on the enclosing function
	Direct            []*funcInfo // every function it may land on (interface: each implementation)
	To                *ToRef      // the declaration it names (for an interface, the interface method)
}

type hit struct {
	fn  *funcInfo
	via []string
}

type wrapper struct {
	ok      bool
	targets []*funcInfo
}

type project struct {
	root     string // absolute
	evalRoot string // root with symlinks resolved
	fset     *token.FileSet
	pkgs     []*packages.Package // project packages that type-checked, by path
	pkgPaths map[string]bool
	funcs    map[*types.Func]*funcInfo
	byKey    map[string]*funcInfo // file + "\x00" + name
	problems []string
	degraded bool
	files    map[string]bool // files of every loaded package, type-checked or not
	failed   map[string]bool // files of packages that did not type-check

	sites    map[*funcInfo][]tsite
	impls    map[*types.Func][]*funcInfo
	wrappers map[*funcInfo]wrapper
}

// engineVersion is the checker's module version and the Go version.
func engineVersion() string {
	v := "(devel)"
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" {
		v = bi.Main.Version
	}
	return "pr-tour/checker@" + v + " " + runtime.Version()
}

// loadProject loads every package under root with types, never downloading
// anything (see loaderEnv).
func loadProject(root string) (*project, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	p := &project{
		root: abs, evalRoot: abs, pkgPaths: map[string]bool{},
		files: map[string]bool{}, failed: map[string]bool{},
		funcs: map[*types.Func]*funcInfo{}, byKey: map[string]*funcInfo{},
		sites: map[*funcInfo][]tsite{}, impls: map[*types.Func][]*funcInfo{}, wrappers: map[*funcInfo]wrapper{},
	}
	if e, err := filepath.EvalSymlinks(abs); err == nil {
		p.evalRoot = e
	}
	cfg := &packages.Config{Mode: loadMode, Dir: abs, Tests: false, Env: loaderEnv(os.Environ())}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, &loadError{fmt.Errorf("load packages: %w", err)}
	}
	sort.Slice(pkgs, func(i, j int) bool { return pkgs[i].PkgPath < pkgs[j].PkgPath })
	for _, pkg := range pkgs {
		bad := len(pkg.Errors) > 0 || pkg.IllTyped || pkg.Types == nil || pkg.TypesInfo == nil
		for _, name := range append(append([]string(nil), pkg.GoFiles...), pkg.CompiledGoFiles...) {
			if r, ok := p.rel(name); ok {
				p.files[r] = true
				if bad {
					p.failed[r] = true
				}
			}
		}
		// A package that does not type-check is left out: steps in it and
		// links through it fall back to the syntax result.
		if bad {
			msg := "unknown error"
			if len(pkg.Errors) > 0 {
				msg = pkg.Errors[0].Msg
			}
			p.problems = append(p.problems, fmt.Sprintf("package %s does not type-check (%s); its links are matched by name", pkg.PkgPath, msg))
			p.degraded = true
			continue
		}
		p.fset = pkg.Fset
		p.pkgs = append(p.pkgs, pkg)
		p.pkgPaths[pkg.PkgPath] = true
		for _, f := range pkg.Syntax {
			rel, ok := p.rel(pkg.Fset.File(f.Pos()).Name())
			if !ok {
				continue
			}
			gen := ast.IsGenerated(f)
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok {
					continue
				}
				obj, ok := pkg.TypesInfo.Defs[fd.Name].(*types.Func)
				if !ok {
					continue
				}
				fi := &funcInfo{
					File: rel, Name: funcName(fd), Decl: fd, Pkg: pkg, Generated: gen,
					Line: pkg.Fset.Position(fd.Pos()).Line, End: pkg.Fset.Position(fd.End()).Line,
				}
				p.funcs[obj] = fi
				p.byKey[rel+"\x00"+fi.Name] = fi
			}
		}
	}
	if len(p.pkgs) == 0 {
		// Nothing of the project type-checked (missing modules, no packages):
		// the caller runs the syntax check instead.
		return nil, &loadError{fmt.Errorf("no package of the project type-checks (%d loaded)", len(pkgs))}
	}
	return p, nil
}

// loadError is a project that cannot be loaded with types at all; the
// command exits with code 3 and prints nothing on stdout.
type loadError struct{ err error }

func (e *loadError) Error() string { return e.err.Error() }
func (e *loadError) Unwrap() error { return e.err }

// loaderEnv is the environment for loading the analysed project: the
// process's own, with GOPROXY=off, GOFLAGS=-mod=readonly and
// GOTOOLCHAIN=local appended so they win over anything the caller set. The
// checker never downloads anything, whoever runs it.
func loaderEnv(base []string) []string {
	env := append([]string(nil), base...)
	return append(env, "GOPROXY=off", "GOFLAGS=-mod=readonly", "GOTOOLCHAIN=local")
}

// rel gives a file's slash path relative to the root.
func (p *project) rel(name string) (string, bool) {
	for _, base := range []string{p.root, p.evalRoot} {
		if r, err := filepath.Rel(base, name); err == nil && filepath.IsLocal(r) {
			return filepath.ToSlash(r), true
		}
	}
	return "", false
}

// resolve gives the project functions a used function may land on, and the
// declaration it names. Functions outside the project give nothing.
func (p *project) resolve(fn *types.Func) ([]*funcInfo, *ToRef) {
	fn = fn.Origin()
	if fi := p.funcs[fn]; fi != nil {
		return []*funcInfo{fi}, &ToRef{File: fi.File, Line: fi.Line}
	}
	if fn.Pkg() == nil || !p.pkgPaths[fn.Pkg().Path()] {
		return nil, nil
	}
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Recv() == nil {
		return nil, nil
	}
	iface, ok := sig.Recv().Type().Underlying().(*types.Interface)
	if !ok {
		return nil, nil
	}
	var to *ToRef
	pos := p.fset.Position(fn.Pos())
	if rel, ok := p.rel(pos.Filename); ok {
		to = &ToRef{File: rel, Line: pos.Line}
	}
	return p.implementations(fn, iface), to
}

// implementations lists the methods of the project's named types that
// implement the interface of method m, in package and name order.
func (p *project) implementations(m *types.Func, iface *types.Interface) []*funcInfo {
	if got, ok := p.impls[m]; ok {
		return got
	}
	var out []*funcInfo
	seen := map[*funcInfo]bool{}
	for _, pkg := range p.pkgs {
		scope := pkg.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			named, ok := tn.Type().(*types.Named)
			if !ok || named.TypeParams().Len() > 0 || types.IsInterface(named) {
				continue
			}
			ptr := types.NewPointer(named)
			if !types.Implements(named, iface) && !types.Implements(ptr, iface) {
				continue
			}
			obj, _, _ := types.LookupFieldOrMethod(ptr, false, m.Pkg(), m.Name())
			f, ok := obj.(*types.Func)
			if !ok {
				continue
			}
			if fi := p.funcs[f.Origin()]; fi != nil && !seen[fi] {
				seen[fi] = true
				out = append(out, fi)
			}
		}
	}
	p.impls[m] = out
	return out
}

// sitesOf lists the resolved calls and references in a function, closures
// included, in source order.
func (p *project) sitesOf(fi *funcInfo) []tsite {
	if got, ok := p.sites[fi]; ok {
		return got
	}
	sites := []tsite{}
	if fi.Decl.Body != nil {
		info, fset := fi.Pkg.TypesInfo, fi.Pkg.Fset
		callee := map[*ast.Ident]bool{}
		ast.Inspect(fi.Decl.Body, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				if id := calleeIdent(x.Fun); id != nil {
					callee[id] = true
				}
				// A closure handed to a call (a registration) lands on the
				// enclosing function: the closure is part of it.
				for _, a := range x.Args {
					if lit, ok := ast.Unparen(a).(*ast.FuncLit); ok {
						ps := fset.Position(lit.Pos())
						sites = append(sites, tsite{
							Line: ps.Line, Col: ps.Column, EndCol: ps.Column + len("func"),
							Closure: true, Direct: []*funcInfo{fi},
						})
					}
				}
			case *ast.Ident:
				fn, ok := info.Uses[x].(*types.Func)
				if !ok {
					break
				}
				direct, to := p.resolve(fn)
				if len(direct) == 0 && to == nil {
					break
				}
				ps, pe := fset.Position(x.Pos()), fset.Position(x.End())
				sites = append(sites, tsite{
					Line: ps.Line, Col: ps.Column, EndCol: pe.Column,
					IsCall: callee[x], Direct: direct, To: to,
				})
			}
			return true
		})
	}
	sort.SliceStable(sites, func(i, j int) bool {
		if sites[i].Line != sites[j].Line {
			return sites[i].Line < sites[j].Line
		}
		return sites[i].Col < sites[j].Col
	})
	p.sites[fi] = sites
	return sites
}

// calleeIdent gives the name a call goes through: f in f(), x.f(), f[T]().
func calleeIdent(e ast.Expr) *ast.Ident {
	for {
		switch x := ast.Unparen(e).(type) {
		case *ast.Ident:
			return x
		case *ast.SelectorExpr:
			return x.Sel
		case *ast.IndexExpr:
			e = x.X
		case *ast.IndexListExpr:
			e = x.X
		default:
			return nil
		}
	}
}

// wrapperTargets gives what a thin wrapper calls: a function outside
// generated code whose body has at most 3 statements and exactly one call to
// a project function. ok is false when fi is no thin wrapper.
func (p *project) wrapperTargets(fi *funcInfo) ([]*funcInfo, bool) {
	if w, ok := p.wrappers[fi]; ok {
		return w.targets, w.ok
	}
	var w wrapper
	if !fi.Generated && fi.Decl.Body != nil && len(fi.Decl.Body.List) <= 3 {
		calls := 0
		for _, s := range p.sitesOf(fi) {
			if s.IsCall {
				calls++
				w.targets = s.Direct
			}
		}
		w.ok = calls == 1
	}
	if !w.ok {
		w.targets = nil
	}
	p.wrappers[fi] = w
	return w.targets, w.ok
}

// expand gives where a site lands, following at most one thin wrapper when
// the direct target is not a step.
func (p *project) expand(s tsite, isStep func(*funcInfo) bool) []hit {
	var hits []hit
	for _, d := range s.Direct {
		hits = append(hits, hit{fn: d})
		if !s.IsCall || isStep(d) {
			continue
		}
		if inner, ok := p.wrapperTargets(d); ok {
			for _, t := range inner {
				if t != d {
					hits = append(hits, hit{fn: t, via: []string{d.Name}})
				}
			}
		}
	}
	return hits
}

type typedStep struct {
	fn    *funcInfo
	sites []tsite
}

// typeStep gives the typed function of an anchored step, or nil when its
// file is not type-checked.
func (p *project) typeStep(ss *stepState) *typedStep {
	if ss.anchor == nil {
		return nil
	}
	fi := p.byKey[ss.step.File+"\x00"+ss.anchor.Name]
	if fi == nil {
		return nil
	}
	return &typedStep{fn: fi, sites: p.sitesOf(fi)}
}

// checkTyped checks a tour with go/types: it anchors steps, proves or
// rejects Claude's links, finds links Claude did not give and records call
// sites. Steps and links in files that did not type-check keep the syntax
// result.
func checkTyped(root string, in CheckInput) (CheckOutput, error) {
	p, err := loadProject(root)
	if err != nil {
		return CheckOutput{}, err
	}
	out := newOutput("go-types", engineVersion())
	out.Problems = append(out.Problems, p.problems...)
	for i, states := range syntaxStates(root, in) {
		fc := &flowCheck{p: p, states: states, typed: map[*stepState]*typedStep{}}
		var untyped []string
		for _, ss := range states {
			fc.typed[ss] = p.typeStep(ss)
			if ss.anchor != nil && fc.typed[ss] == nil {
				untyped = append(untyped, p.untypedProblem(ss))
			}
		}
		fc.anchorByIncomingLinks()
		fc.indexSteps()
		links := claudeLinks(states, fc.check)
		links = append(links, fc.discover(links)...)
		sortLinks(links)
		for _, ss := range states {
			ss.res.CallSites = fc.callSites(ss)
			out.Steps[ss.step.ID] = ss.res
			out.Problems = append(out.Problems, ss.problems...)
		}
		out.Problems = append(out.Problems, untyped...)
		out.Problems = append(out.Problems, fc.problems...)
		out.Links[in.Flows[i].ID] = links
	}
	out.Degraded = p.degraded
	return out, nil
}

// untypedProblem explains why an anchored step has no types. A file that is
// in no loaded package (a test file or build tags) is expected and only
// noted; a file in a package that failed to load marks the run degraded.
func (p *project) untypedProblem(ss *stepState) string {
	file := ss.step.File
	switch {
	case p.failed[file]:
		p.degraded = true
		return fmt.Sprintf("step %s: %s is in a package that does not type-check; its links are matched by name", ss.step.ID, file)
	case !p.files[file]:
		return fmt.Sprintf("step %s: %s is not part of the normal build (build tags or test file); its links are matched by name", ss.step.ID, file)
	}
	return fmt.Sprintf("step %s: %s is not type-checked; its links are matched by name", ss.step.ID, file)
}

type flowCheck struct {
	p        *project
	states   []*stepState
	typed    map[*stepState]*typedStep
	owner    map[*funcInfo]*stepState   // first step on a function
	stepsOn  map[*funcInfo][]*stepState // every step on a function
	problems []string
}

func (fc *flowCheck) indexSteps() {
	fc.owner = map[*funcInfo]*stepState{}
	fc.stepsOn = map[*funcInfo][]*stepState{}
	for _, ss := range fc.states {
		if t := fc.typed[ss]; t != nil {
			if fc.owner[t.fn] == nil {
				fc.owner[t.fn] = ss
			}
			fc.stepsOn[t.fn] = append(fc.stepsOn[t.fn], ss)
		}
	}
}

func (fc *flowCheck) isStep(fi *funcInfo) bool { return fc.owner[fi] != nil }

// anchorByIncomingLinks anchors a step whose symbol was not found, or that
// has no symbol, on the function a call of Claude's incoming link lands on
// (spec Pass B step 1). The claimed line must name exactly one function of
// the step's file; otherwise the step keeps its range anchor.
func (fc *flowCheck) anchorByIncomingLinks() {
	for i, ss := range fc.states {
		if ss.file == nil || (ss.anchor != nil && ss.anchor.Source == "symbol") {
			continue
		}
		type claim struct {
			caller *stepState
			line   int
		}
		var claims []claim
		if f := ss.step.From; f != nil && f.How == "call" && f.Step >= 1 && f.Step <= len(fc.states) && f.Step-1 != i {
			claims = append(claims, claim{fc.states[f.Step-1], f.Line})
		}
		for _, o := range fc.states {
			for _, c := range o.step.Calls {
				if o != ss && ss.step.Symbol != "" && c.File == ss.step.File && c.Symbol == ss.step.Symbol {
					claims = append(claims, claim{o, c.Line})
				}
			}
		}
		var target *funcInfo
		for _, c := range claims {
			t := fc.typed[c.caller]
			if t == nil {
				continue
			}
			var found []*funcInfo
			for _, s := range t.sites {
				if s.Line != c.line || s.Closure {
					continue
				}
				for _, d := range s.Direct {
					if d.File == ss.step.File && !containsFunc(found, d) {
						found = append(found, d)
					}
				}
			}
			if len(found) == 1 {
				target = found[0]
				break
			}
		}
		if target == nil || ss.file.funcByName(target.Name) == nil {
			continue
		}
		problem := fmt.Sprintf("step %s: no symbol given in %s; anchored by incoming link to %s", ss.step.ID, ss.step.File, target.Name)
		if ss.step.Symbol != "" {
			problem = fmt.Sprintf("step %s: symbol %s not found in %s; anchored by incoming link to %s", ss.step.ID, ss.step.Symbol, ss.step.File, target.Name)
		}
		ss.setAnchor(&Anchor{Name: target.Name, StartLine: target.Line, EndLine: target.End, Source: "incoming-link"}, problem)
		fc.typed[ss] = fc.p.typeStep(ss)
	}
}

func containsFunc(list []*funcInfo, f *funcInfo) bool {
	for _, x := range list {
		if x == f {
			return true
		}
	}
	return false
}

// check proves or rejects one of Claude's links. When either end is not
// type-checked the link keeps the syntax result.
func (fc *flowCheck) check(l Link, caller, callee *stepState) Link {
	tc, te := fc.typed[caller], fc.typed[callee]
	if tc == nil || te == nil {
		return nameCheck(l, caller, callee)
	}
	var best *tsite
	var bestHit hit
	rank := -1
	for i := range tc.sites {
		s := &tc.sites[i]
		for _, h := range fc.p.expand(*s, fc.isStep) {
			if h.fn != te.fn {
				continue
			}
			r := 0
			if s.IsCall {
				r = 1
			}
			if s.Line == l.Line {
				r += 2
			}
			if r > rank {
				best, bestHit, rank = s, h, r
			}
		}
	}
	if best == nil {
		l.Check = "not-found"
		fc.landsElsewhere(l, tc, te)
		return l
	}
	l.Check = "proven"
	l.Source = "both"
	if !best.IsCall {
		l.How = "register"
	}
	l.Via = bestHit.via
	setLine(&l, best.Line)
	return l
}

// landsElsewhere records a problem when Claude's line calls another function
// of the callee's file: the tour likely names the wrong function.
func (fc *flowCheck) landsElsewhere(l Link, tc, te *typedStep) {
	for _, s := range tc.sites {
		if s.Line != l.Line || s.Closure {
			continue
		}
		for _, d := range s.Direct {
			if d.File == te.fn.File && d != te.fn {
				fc.problems = append(fc.problems, fmt.Sprintf("link %s->%s: line %d calls %s, not %s", l.From, l.To, l.Line, d.Name, te.fn.Name))
				return
			}
		}
	}
}

// discover finds the links Claude did not give: calls and references that
// land in another step's function of the flow. A function anchored by
// several steps gives code links only from the first of them. Nothing found
// lands in generated code.
func (fc *flowCheck) discover(claude []Link) []Link {
	seen := map[[2]string]bool{}
	for _, l := range claude {
		seen[[2]string{l.From, l.To}] = true
	}
	var links []Link
	for _, caller := range fc.states {
		tc := fc.typed[caller]
		if tc == nil || fc.owner[tc.fn] != caller {
			continue
		}
		for _, s := range tc.sites {
			for _, h := range fc.p.expand(s, fc.isStep) {
				if h.fn.Generated || h.fn == tc.fn {
					continue
				}
				for _, callee := range fc.stepsOn[h.fn] {
					key := [2]string{caller.step.ID, callee.step.ID}
					if seen[key] {
						continue
					}
					seen[key] = true
					how := "call"
					if !s.IsCall {
						how = "register"
					}
					links = append(links, Link{From: caller.step.ID, To: callee.step.ID, Line: s.Line, How: how, Via: h.via, Source: "code", Check: "proven"})
				}
			}
		}
	}
	return links
}

// callSites lists every call and reference in a step's function that lands
// on a project function, with the step it goes to when there is one.
func (fc *flowCheck) callSites(ss *stepState) []CallSite {
	out := []CallSite{}
	t := fc.typed[ss]
	if t == nil {
		return out
	}
	for _, s := range t.sites {
		if s.Closure {
			continue
		}
		cs := CallSite{Line: s.Line, Col: s.Col, EndCol: s.EndCol}
		for _, d := range s.Direct {
			if o := fc.owner[d]; o != nil {
				cs.To, cs.ToStep = ToRef{File: d.File, Line: d.Line}, o.step.ID
				break
			}
		}
		if cs.ToStep == "" {
			switch {
			case len(s.Direct) == 1:
				cs.To = ToRef{File: s.Direct[0].File, Line: s.Direct[0].Line}
			case s.To != nil:
				cs.To = *s.To
			default:
				continue
			}
		}
		out = append(out, cs)
	}
	return out
}
