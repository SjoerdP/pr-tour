// Command pr-tour-check-go analyses the Go code of a PR. It reads JSON on
// stdin and writes JSON on stdout.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

const usage = `usage:
  pr-tour-check-go version
  pr-tour-check-go functions --root <dir>   (FunctionsInput on stdin)
  pr-tour-check-go check --root <dir> [--syntax-only]   (CheckInput on stdin)

check exits 3 when the project cannot be loaded with types (the caller then
runs --syntax-only). It loads the project with go/types. It always loads with GOPROXY=off,
GOFLAGS=-mod=readonly and GOTOOLCHAIN=local, so it never downloads anything.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Fprintln(stdout, CheckerVersion)
		return 0
	case "functions":
		fs := flag.NewFlagSet("functions", flag.ContinueOnError)
		fs.SetOutput(stderr)
		root := fs.String("root", "", "repository root")
		if err := fs.Parse(args[1:]); err != nil || *root == "" || fs.NArg() > 0 {
			fmt.Fprint(stderr, usage)
			return 2
		}
		var in FunctionsInput
		if err := json.NewDecoder(stdin).Decode(&in); err != nil {
			fmt.Fprintln(stderr, "read input:", err)
			return 1
		}
		out, err := listFunctions(*root, in)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if err := json.NewEncoder(stdout).Encode(out); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	case "check":
		fs := flag.NewFlagSet("check", flag.ContinueOnError)
		fs.SetOutput(stderr)
		root := fs.String("root", "", "repository root")
		syntaxOnly := fs.Bool("syntax-only", false, "check by syntax only, without type information")
		if err := fs.Parse(args[1:]); err != nil || *root == "" || fs.NArg() > 0 {
			fmt.Fprint(stderr, usage)
			return 2
		}
		var in CheckInput
		if err := json.NewDecoder(stdin).Decode(&in); err != nil {
			fmt.Fprintln(stderr, "read input:", err)
			return 1
		}
		check := checkTyped
		if *syntaxOnly {
			check = checkSyntax
		}
		out, err := check(*root, in)
		if err != nil {
			fmt.Fprintln(stderr, err)
			var le *loadError
			if errors.As(err, &le) {
				return 3
			}
			return 1
		}
		if err := json.NewEncoder(stdout).Encode(out); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
	fmt.Fprintf(stderr, "unknown command %q\n", args[0])
	fmt.Fprint(stderr, usage)
	return 2
}
