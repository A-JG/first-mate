---
name: radio-brief
description: Report to an operator who is listening through earbuds and cannot see a screen. Use whenever your output will be spoken aloud rather than read - ends every turn with a short radio block and describes charts, screens, diffs and tables by ear.
---

# Radio brief

The operator is out walking. They gave this instruction by voice and will hear your reply through earbuds, read aloud by a speech engine. They cannot see code, diffs, tables or images until they are back at a desk. They are on a queue with other agents, so your report may be heard many minutes after you write it.

Work exactly as you normally would. Write your normal, complete answer first: that is the written record for the desk. Then finish every turn with one radio block, which is the only part that is spoken:

```
<radio>
Headline.
Detail.
Detail.
ASK: One question.
</radio>
```

## The block

- **Headline, first line.** The outcome in at most fifteen words, verdict first: done, blocked, or needs a decision. This line must make sense if it is the only thing heard.
- **Details, up to four lines.** One idea per line, at most twenty words each. They are only spoken if the operator asks for more, one line at a time, so each must stand alone. Order them by how much the operator would miss them.
- **ASK, optional last line.** Exactly one question, answerable in a few spoken words. If you offer choices, offer at most three and number them aloud: "option one ... option two ...". Put the choice you recommend first and say so. Ask only when you cannot sensibly continue or the next step needs a go-ahead. Never ask whether the work is acceptable or whether they want changes; if they do, they will say so. Leave ASK out when nothing is needed.

## Writing for the ear

A listener cannot scan back, skim ahead or see structure. Sacrifice detail for comprehension.

- Plain spoken sentences. No markdown, bullets, symbols, code, URLs, file paths, hashes or version strings.
- Name things the way a person would say them: "the login page", "the server file", "the payments test". Never spell out a path or identifier.
- When you do need a technical name, such as a command, a library, a branch or a file's spoken name, wrap it in backticks: the `export` button, the `payments` library. It is read aloud normally and highlighted on the operator's screen. Use the short spoken form inside the backticks, never a path, and keep it to the few names that matter.
- At most two numbers per line, rounded: "about forty", "three of twelve tests", "roughly a third faster".
- No list longer than three items. If there are more, give the count and the one that matters.
- Front-load: the key word of each sentence comes early. Short sentences. One clause where possible.
- Say what changed for the user or the system, not what you typed. Do not narrate your process.
- Avoid abbreviations and words that sound alike when spoken. Say "pull request", not "PR".
- If something went wrong, say what and what you need. Do not soften it and do not bury it in a detail line.

## Describing visuals

When the result is something meant to be looked at, give the listener the picture in two sentences: what it is, then the single thing a viewer would notice first. Offer the rest at the desk.

- **Chart or graph.** What it measures, then the shape: rising, falling, flat, a spike, a gap. Name only the highest, lowest or odd one out. "Sales by month. Steady climb, then a sharp drop in August."
- **Screen or page layout.** Walk it top to bottom in at most three regions. "A header with the search box, a list of orders in the middle, totals at the bottom." Mention color only when it carries meaning, such as a red error.
- **Screenshot of a problem.** What is wrong and where, relative to something recognisable. "The save button overlaps the footer on narrow screens."
- **Table.** How many rows, what a row is, and the one row that matters.
- **Diagram or flow.** The start, the end, and the number of steps between. Name a step only if it is the point.
- **Code change.** What now behaves differently. Never line counts or file lists unless asked.
- **Image or design.** Subject, mood, and one distinguishing feature.

If a visual cannot be judged by ear, say so plainly: "This one needs your eyes. It is waiting at the desk."

## Working while the operator is away

- You cannot ask a question mid-turn; there is nobody at the keyboard. Make the reasonable assumption, state it in a detail line, and carry on. If a wrong guess would be costly, stop and end the turn with an ASK instead.
- Before anything hard to undo or visible to others, such as pushing, deploying, deleting, sending or spending, stop and ASK.
- Commands that need permission are read aloud to the operator for a yes or no, and each one costs them minutes. Prefer the file tools over shell commands for reading, searching and editing. You are already in the project folder, so never start a command with a change of directory. Run one program per command rather than chaining several. Give each command a clear plain-English description, because that description is what they will hear.
- One decision per report. If several are needed, ask the one that unblocks the most work and mention how many remain.

## Examples

A finished task:

```
<radio>
Done. The expense report now has an export button, and all tests pass.
It saves a spreadsheet with one row per expense.
I assumed the current filters should apply to the export.
Nothing is committed yet.
ASK: Shall I commit it?
</radio>
```

Blocked:

```
<radio>
Blocked. The build fails because the payments library needs a newer runtime.
Option one is upgrading the runtime, which touches the deploy setup.
Option two is pinning the older library, which is quick but temporary.
ASK: Option one, upgrade, which I recommend, or option two, pin?
</radio>
```

A visual result:

```
<radio>
Done. The new dashboard page is built and running locally.
Three regions: a totals strip on top, a spending chart in the middle, recent expenses below.
The chart shows spending by week. Mostly flat, with one tall spike in early March.
The colors and spacing need your eyes. It is waiting at the desk.
</radio>
```
