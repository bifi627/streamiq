package service

import (
	"encoding/binary"
	"encoding/xml"
	"strings"
	"testing"
	"unicode/utf16"
)

// The task XML must parse and carry what makes the gateway a long-running,
// visible, per-user process: no run limit, no battery stop, cmd /k + run.
func TestTaskXML(t *testing.T) {
	b := TaskXML(`PC\Jo & Co`, `C:\Users\Jo & Co\AppData\Local\streamiq\gateway.exe`, `C:\Users\Jo & Co\AppData\Local\streamiq`)
	if b[0] != 0xFF || b[1] != 0xFE {
		t.Fatal("want UTF-16LE BOM")
	}
	u := make([]uint16, (len(b)-2)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2+2*i:])
	}
	doc := string(utf16.Decode(u))
	var task struct {
		UserID  string `xml:"Triggers>LogonTrigger>UserId"`
		Limit   string `xml:"Settings>ExecutionTimeLimit"`
		Battery string `xml:"Settings>StopIfGoingOnBatteries"`
		Command string `xml:"Actions>Exec>Command"`
		Args    string `xml:"Actions>Exec>Arguments"`
		WorkDir string `xml:"Actions>Exec>WorkingDirectory"`
	}
	// encoding/xml refuses a non-UTF-8 declaration; the content is what matters.
	d := xml.NewDecoder(strings.NewReader(strings.Replace(doc, `encoding="UTF-16"`, "", 1)))
	if err := d.Decode(&task); err != nil {
		t.Fatal(err)
	}
	want := map[string][2]string{
		"user":    {task.UserID, `PC\Jo & Co`},
		"limit":   {task.Limit, "PT0S"},
		"battery": {task.Battery, "false"},
		"command": {task.Command, "cmd.exe"},
		"args":    {task.Args, `/k ""C:\Users\Jo & Co\AppData\Local\streamiq\gateway.exe" run"`},
		"workdir": {task.WorkDir, `C:\Users\Jo & Co\AppData\Local\streamiq`},
	}
	for k, v := range want {
		if v[0] != v[1] {
			t.Errorf("%s = %q, want %q", k, v[0], v[1])
		}
	}
}
