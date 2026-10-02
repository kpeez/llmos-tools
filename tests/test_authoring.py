"""The authoring check catches missing navigation without rewriting content."""

from __future__ import annotations

import json
import os
import subprocess
import sys


def test_check_reports_unlinked_notes_but_not_examples_or_ambiguous_names(tmp_path):
    vault = tmp_path / "vault"
    manuscript = vault / "projects" / "study" / "manuscript"
    manuscript.mkdir(parents=True)
    (vault / ".obsidian").mkdir()
    (vault / "AGENTS.md").write_text("# Vault\n")
    (manuscript.parent / "study.md").write_text("# Study\n")
    for name in ("methods.md", "results.md", "example.md", "nested.md"):
        (manuscript / name).write_text(f"# {name}\n")
    for folder in ("one", "two"):
        (vault / folder).mkdir()
        (vault / folder / "shared.md").write_text("# Shared\n")
    note = manuscript / "README.md"
    note.write_text(
        '---\nproject: ["[[projects/study/study]]"]\n---\n\n'
        "# Reading order\n\n"
        "1. `methods.md` — protocol.\n"
        "2. [[projects/study/manuscript/results|Results]].\n"
        "3. [Results again](results.md).\n"
        "4. methods.md — another mention.\n\n"
        "The example command is `cat example.md`.\n"
        "```sh\ncat example.md\n```\n"
        "<!-- example.md -->\n"
        "%% example.md %%\n"
        "Unresolved: `missing.md`; ambiguous: `shared.md`.\n"
        "External: https://example.org/example.md\n"
        "- Supporting reading:\n    - nested.md — nested navigation.\n\n"
        "A literal code sample:\n\n    cat example.md\n"
        "\nExample output:\n\n    - example.md\n"
    )
    before = {p: p.read_bytes() for p in vault.rglob("*.md")}
    env = {**os.environ, "LLMOS_ROOT": str(vault)}
    result = subprocess.run(
        [sys.executable, "-m", "llmos_vault.cli", "check", "projects/study/manuscript/README.md"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, result.stderr
    report = json.loads(result.stdout)
    assert report["path"] == "projects/study/manuscript/README.md"
    assert report["property_links"] == ["projects/study/study"]
    assert "projects/study/manuscript/results" in report["body_links"]
    assert [(f["code"], f["line"], f["target"]) for f in report["findings"]] == [
        ("unlinked-note", 7, "projects/study/manuscript/methods"),
        ("unlinked-note", 21, "projects/study/manuscript/nested"),
    ]
    assert before == {p: p.read_bytes() for p in vault.rglob("*.md")}

    note.write_text(
        note.read_text()
        .replace("`methods.md`", "[[methods|Methods]]")
        .replace("4. methods.md", "4. [[methods|Methods]]")
        .replace("    - nested.md", "    - [[nested|Nested]]")
    )
    result = subprocess.run(
        [sys.executable, "-m", "llmos_vault.cli", "check", "projects/study/manuscript/README.md"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["findings"] == []
