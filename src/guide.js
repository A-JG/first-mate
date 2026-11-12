// The on-screen guide: what each term in the active language pack means.
// Built from the pack so it is always in step with the words in use.
const MEANING = {
  end: 'Ends your transmission and sends it. Nothing is sent until you say this.',
  yes: 'Yes. Confirms a read-back, approves a request, or acknowledges a report.',
  no: 'No. Cancels a read-back, denies a request, or scraps what you are dictating. Add a reason to redirect the agent.',
  next: 'Plays the next waiting item. Also carries on after a hold.',
  more: 'One more detail from the report on the air.',
  repeat: 'Repeats the last thing said.',
  skip: 'Sends the item on the air to the back of the line.',
  out: 'Marks the thread on the air as finished and frees its name.',
  sitrep: 'Who is working and what is waiting for you.',
  standby: 'Holds all announcements until you ask for the next item.',
  radiocheck: 'Connection test.',
  interrupt: 'Stops the dispatcher mid-sentence; it remembers where. Then say anything: a clarification goes to that agent, a new idea becomes a new thread, and the report picks up afterwards. Works in one breath too.',
  resume: 'Carries on the interrupted report from the sentence where you stopped it.',
  newProject: 'Starts a brand-new project. Name it in the same breath, then give the first instruction.',
  newThread: 'Starts a fresh thread in the project you name, even if a related one is open.',
  callsign: 'Start with a thread name to speak to that thread directly.',
};

export function buildGuide(pack) {
  const end = pack.terminators[0];
  const entry = (key, phrases, example) => ({
    key, term: phrases[0], aliases: phrases.slice(1), meaning: MEANING[key], example,
  });
  const no = pack.commands.no;
  return [
    entry('end', pack.terminators, `In recipe box, fix the header, ${end}.`),
    entry('yes', pack.commands.yes),
    entry('no', no, `${no[1] ?? no[0]}, use the other library, ${end}.`),
    entry('next', pack.commands.next),
    entry('more', pack.commands.more),
    entry('repeat', pack.commands.repeat),
    entry('skip', pack.commands.skip),
    entry('out', pack.commands.out),
    entry('sitrep', pack.commands.sitrep),
    entry('standby', pack.commands.standby),
    entry('radiocheck', pack.commands.radiocheck),
    entry('interrupt', pack.commands.interrupt, `${pack.commands.interrupt[0]}, use the other library instead, ${end}.`),
    entry('resume', pack.commands.resume),
    entry('newProject', pack.newProject, `${pack.newProject[0]}, call it bird log, list sightings by day, ${end}.`),
    entry('newThread', pack.newThread, `${pack.newThread[0]}, in recipe box, tidy the footer, ${end}.`),
    { key: 'callsign', term: pack.callsigns.slice(0, 3).join(', '), aliases: [], meaning: MEANING.callsign,
      example: `${pack.callsigns[0]}, also add tests, ${end}.` },
  ];
}
