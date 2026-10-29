package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
)

// listFunctions returns the functions and methods of the input files that
// contain a changed line. Parsing is syntax only, so build tags are ignored.
// The doc comment of a function does not count as part of it.
func listFunctions(root string, in FunctionsInput) (FunctionsOutput, error) {
	out := FunctionsOutput{Version: CheckerVersion, Functions: []FuncInfo{}}
	fset := token.NewFileSet()
	for _, f := range in.Files {
		file, err := parser.ParseFile(fset, filepath.Join(root, filepath.FromSlash(f.Path)), nil, parser.ParseComments)
		if err != nil {
			return out, fmt.Errorf("parse %s: %w", f.Path, err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			start := fset.Position(fn.Pos()).Line
			end := fset.Position(fn.End()).Line
			if !anyInRange(f.Lines, start, end) {
				continue
			}
			out.Functions = append(out.Functions, FuncInfo{
				File: f.Path, Name: funcName(fn), StartLine: start, EndLine: end,
			})
		}
	}
	sort.SliceStable(out.Functions, func(i, j int) bool {
		a, b := out.Functions[i], out.Functions[j]
		if a.File != b.File {
			return a.File < b.File
		}
		return a.StartLine < b.StartLine
	})
	return out, nil
}

func anyInRange(lines []int, start, end int) bool {
	for _, l := range lines {
		if l >= start && l <= end {
			return true
		}
	}
	return false
}

// funcName gives "Name" for functions and "Recv.Name" for methods, without
// pointer stars or type parameters.
func funcName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return fn.Name.Name
	}
	return recvTypeName(fn.Recv.List[0].Type) + "." + fn.Name.Name
}

func recvTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvTypeName(t.X)
	case *ast.ParenExpr:
		return recvTypeName(t.X)
	case *ast.IndexExpr:
		return recvTypeName(t.X)
	case *ast.IndexListExpr:
		return recvTypeName(t.X)
	case *ast.Ident:
		return t.Name
	}
	return "?"
}
