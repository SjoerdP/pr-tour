// Command pr-tour-check-go analyses the Go code of a PR. It reads JSON on
// stdin and writes JSON on stdout.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

const usage = `usage:
  pr-tour-check-go version
  pr-tour-check-go functions --root <dir>   (FunctionsInput on stdin)
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
	}
	fmt.Fprintf(stderr, "unknown command %q\n", args[0])
	fmt.Fprint(stderr, usage)
	return 2
}
