package db_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// gosec's SQL rules and sqlclosecheck only see database/sql, so the API's pgx code is checked
// from source. ponytail: matched by method name and argument shape, not by type; a type-checked
// pass (go/types) if a false positive shows up.
func TestSQLSource(t *testing.T) {
	pkgs := map[string][]*ast.File{}
	fset := token.NewFileSet()
	err := filepath.WalkDir("../..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		pkgs[filepath.Dir(path)] = append(pkgs[filepath.Dir(path)], f)
		return err
	})
	if err != nil || len(pkgs) == 0 {
		t.Fatal("no Go source read:", err)
	}
	for _, files := range pkgs {
		for _, p := range sqlProblems(fset, files) {
			t.Error(p)
		}
	}
	if t.Failed() {
		t.Error("fix: SQL is a constant with $n placeholders; Query rows go to pgx.CollectRows / AppendRows /" +
			" ForEachRow or a defer rows.Close(); an exception says why on a `// sqlcheck: <why>` line")
	}
}

func TestSQLSourceCatches(t *testing.T) {
	const src = `package p
const cols = "a, b"
func ok(ctx context.Context, tx pgx.Tx, sql string) {
	tx.Exec(ctx, sql)
	tx.Exec(r.Context(), "SELECT "+cols+" FROM t")
	rows, _ := tx.Query(ctx, ` + "`SELECT 1`" + `)
	pgx.CollectRows(rows, pgx.RowTo[int])
	more, _ := tx.Query(ctx, "SELECT 1")
	defer more.Close()
	r.URL.Query()
	tx.Exec(ctx, claim.sql) // sqlcheck: the claim's SQL is a literal in db.go
}
func bad(ctx context.Context, tx pgx.Tx, name string) {
	tx.Exec(ctx, fmt.Sprintf("SELECT * FROM %s", name))
	tx.QueryRow(ctx, "SELECT * FROM "+name)
	rows, _ := tx.Query(ctx, "SELECT 1")
	rows.Next()
	_, _ = tx.Query(ctx, "SELECT 1")
}
`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "p.go", src, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	got := sqlProblems(fset, []*ast.File{f})
	want := []string{
		"p.go:14:15: SQL built from strings",
		"p.go:15:19: SQL built from strings",
		"p.go:16:2: rows not closed",
		"p.go:18:2: rows not closed",
	}
	if !slices.Equal(got, want) {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// sqlProblems checks one package: the SQL of a Query / QueryRow / Exec call taking a context
// is a literal, a const of the package or a + of those, or a whole parameter (a wrapper's); every Query
// result goes to a pgx collector or a deferred Close. A `// sqlcheck: <why>` comment on the
// call's line or the line above exempts it.
func sqlProblems(fset *token.FileSet, files []*ast.File) []string {
	consts := map[string]bool{}
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			if d, ok := n.(*ast.GenDecl); ok && d.Tok == token.CONST {
				for _, s := range d.Specs {
					for _, id := range s.(*ast.ValueSpec).Names {
						consts[id.Name] = true
					}
				}
			}
			return true
		})
	}
	var out []string
	for _, f := range files {
		exempt := map[int]bool{}
		for _, g := range f.Comments {
			for _, c := range g.List {
				if strings.HasPrefix(c.Text, "// sqlcheck: ") {
					line := fset.Position(c.Pos()).Line
					exempt[line], exempt[line+1] = true, true
				}
			}
		}
		report := func(n ast.Node, msg string) {
			if pos := fset.Position(n.Pos()); !exempt[pos.Line] {
				out = append(out, fmt.Sprintf("%s:%d:%d: %s", pos.Filename, pos.Line, pos.Column, msg))
			}
		}
		for _, d := range f.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Body != nil {
				checkFunc(fn, consts, report)
			}
		}
	}
	return out
}

func checkFunc(fn *ast.FuncDecl, consts map[string]bool, report func(ast.Node, string)) {
	params := map[string]bool{}
	closed := map[string]bool{}
	ast.Inspect(fn, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.FuncType:
			for _, p := range n.Params.List {
				for _, id := range p.Names {
					params[id.Name] = true
				}
			}
		case *ast.DeferStmt:
			if s, ok := n.Call.Fun.(*ast.SelectorExpr); ok && s.Sel.Name == "Close" {
				if id, ok := s.X.(*ast.Ident); ok {
					closed[id.Name] = true
				}
			}
		case *ast.CallExpr:
			if s, ok := n.Fun.(*ast.SelectorExpr); ok && isPgx(s.X) && slices.Contains(collectors, s.Sel.Name) {
				for _, a := range n.Args {
					if id, ok := a.(*ast.Ident); ok {
						closed[id.Name] = true
					}
				}
			}
		}
		return true
	})
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.CallExpr:
			if dbCall(n) == "" {
				break
			}
			if id, ok := n.Args[1].(*ast.Ident); (!ok || !params[id.Name]) && !constSQL(n.Args[1], consts) {
				report(n.Args[1], "SQL built from strings")
			}
		case *ast.AssignStmt:
			if c, ok := n.Rhs[0].(*ast.CallExpr); ok && len(n.Rhs) == 1 && dbCall(c) == "Query" {
				if id, ok := n.Lhs[0].(*ast.Ident); !ok || !closed[id.Name] {
					report(n, "rows not closed")
				}
			}
		}
		return true
	})
}

// collectors read the rows to the end and close them.
var collectors = []string{"CollectRows", "CollectOneRow", "CollectExactlyOneRow", "AppendRows", "ForEachRow"}

func isPgx(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "pgx"
}

// dbCall is the method name of a Query / QueryRow / Exec call whose first argument is a
// context (ctx, x.Context(), context.Foo()), else "".
func dbCall(c *ast.CallExpr) string {
	s, ok := c.Fun.(*ast.SelectorExpr)
	if !ok || len(c.Args) < 2 || !slices.Contains([]string{"Query", "QueryRow", "Exec"}, s.Sel.Name) {
		return ""
	}
	switch a := c.Args[0].(type) {
	case *ast.Ident:
		if a.Name == "ctx" {
			return s.Sel.Name
		}
	case *ast.CallExpr:
		if f, ok := a.Fun.(*ast.SelectorExpr); ok {
			if x, ok := f.X.(*ast.Ident); f.Sel.Name == "Context" || ok && x.Name == "context" {
				return s.Sel.Name
			}
		}
	}
	return ""
}

func constSQL(e ast.Expr, consts map[string]bool) bool {
	switch e := e.(type) {
	case *ast.BasicLit:
		return e.Kind == token.STRING
	case *ast.Ident:
		return consts[e.Name]
	case *ast.ParenExpr:
		return constSQL(e.X, consts)
	case *ast.BinaryExpr:
		return e.Op == token.ADD && constSQL(e.X, consts) && constSQL(e.Y, consts)
	}
	return false
}
