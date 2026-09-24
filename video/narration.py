# -*- coding: utf-8 -*-
# Narration, one line per scene. (id, text) — start times and budgets are
# derived from the measured audio by timeline.py, and scene.html reads the
# result, so the picture is timed to the voice rather than the voice squeezed
# into the picture.
LINES = [
 ("s00", "This is the copilot in D Twin, a digital twin for a commercial building. "
         "It proposes setpoint changes. A person approves them."),
 ("s01", "The twin doesn't only watch the building. It writes back to it. "
         "Every override expires on its own, the gateway pulls commands instead of having them pushed, "
         "and a safety envelope checks each one at request, and again at dispatch."),
 ("s02", "The copilot is a Lang Graph state machine. This diagram isn't drawn by hand. "
         "It's generated from the compiled graph's own edge list, "
         "the same list the app serves, and the tests read."),
 ("s03", "Here's the whole safety argument. Apply, the only node that touches equipment, "
         "has exactly one way in, from confirm. And confirm is an interrupt: the run stops there, "
         "and waits for a person."),
 ("s03b", "A test walks the graph from the start, refuses to pass through confirm, "
          "and proves that apply is unreachable."),
 ("s04", "Now, a real run, recorded on the development stack. The operator asks to pre-cool "
         "the level three offices before the afternoon peak. The agent reads every zone, "
         "and the control envelope, before anything else."),
 ("s05", "All four offices have good sensors and healthy equipment. So it dry-runs a two kelvin drop "
         "for four hours, the largest single step the envelope allows. Four out of four allowed."),
 ("s06", "Then it proposes the plan. The server dry-runs every command again before the operator sees it, "
         "and the run suspends at confirm. Forty-two seconds in, the state is checkpointed, "
         "and nothing has been applied."),
 ("s07", "The operator approves. That's a new request, resuming the suspended run. "
         "Only now does the graph take the edge into apply."),
 ("s08", "Apply uses the same control endpoint a human click does, as the approving user, "
         "marked as proposed by the copilot. The envelope checks each command again, "
         "and the gateway collected all four within six seconds."),
 ("s09", "On the live map, the four offices now sit about two kelvin under their design setpoint. "
         "The corridor and the meeting room, which weren't in the plan, stay in band. "
         "In four hours the overrides lapse, and nothing has to undo them."),
 ("s10", "Decline takes the other branch, and nothing is issued. The model has four tools. "
         "Three only read, and the fourth only proposes. None of them can write."),
 ("s11", "And what it isn't. The checkpointer is in memory, so a restart forgets a suspended plan. "
         "The gateway here is a simulator, not a real building management system. "
         "And it proposes setpoints. It doesn't optimise the building."),
 ("s12", "D Twin. The copilot proposes. A person approves."),
]
