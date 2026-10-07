# The three-minute demo

The point to land: when the environment is dangerous, remote, private or
disconnected, cloud AI is not good enough, and FIELD keeps working. The moment
the judges get it is when the radio goes off and nothing changes.

## Before you go on stage

1. **Deploy and install.** Push to Netlify (or any HTTPS host). Open the URL
   on the demo phone while online. Tap the status pills and wait for *Offline
   copy: Saved on this device*. Add it to the home screen, so it opens full
   screen and looks like an app, not a tab.
2. **Prove it offline yourself.** Airplane mode, kill the app, reopen it. It
   should load with *Offline* in coral and *On-device* in cyan.
3. **Set the incident** before you start (Earthquake suits debris and water;
   Fire suits smoke).
4. **Dress the room.** The detector is open-vocabulary but not magic. Things
   it finds reliably: people, doors, large printed EXIT signs (green or red,
   lit if you can), fire extinguishers, electrical panels. Things to stage
   generously: a pile of boxes and broken chairs across one doorway as
   "debris", a wide sheet of water or blue tarp on the floor near a panel or a
   printed panel photo, and a teammate lying on the floor.
5. **Check the props with "Analyse a photo"** before the demo. If a prop is not
   detected from 4-5 m, change it, light it, or move it closer. Do not
   discover this on stage.
6. **Calibrate the compass.** Wave the phone in a figure-eight away from the
   laptop and the stage steel. If directions still look wrong indoors, switch
   Direction to *Relative to view*. The answers then say "ahead-left"
   instead of "west", and they are still correct.

## On stage

**0:00 - the line.**
"Every AI assistant you've used today needs the internet. In a fire, an
earthquake or a flood, that's the first thing to go."

**0:15 - cut the network, on camera.** Swipe down, airplane mode on. Tap the
status pills to open the panel and read it out:
*Cloud AI: Unavailable. FIELD: Still running, on this device. 0 network
requests.* Leave it open for a beat. This is the demo.

**0:35 - scan.** Close the panel. Pan slowly, a full circle, about 20 seconds.
Boxes appear on the camera view. On the map, exits, hazards and people land in
their directions and the grey NOT SCANNED wedge shrinks. Narrate what it finds,
not what it is.

**1:00 - ask.** Tap **Safest exit**, then **Speak**. It names the blocked
exit, the risky one and why ("standing water near the electrical panel -
electrocution risk"), and the one to take. Point at the map: the cyan line is
the route, the coral X is the blocked door, the dashed coral link is the water
and the panel.

**1:30 - show it isn't guessing.** Tap **show** on a line to see the
sightings behind it. Tap **Unchecked**: it tells you which way you haven't
looked. "It knows what it hasn't seen."

**1:50 - the human stays in charge.** In the list, mark the recommended exit
**Blocked**. Ask again: the answer moves to the next exit immediately and says
"you marked it blocked".

**2:10 - people.** Tap **People**: "may need help - appears to be on the
floor". Note that it flags, it does not diagnose.

**2:30 - the close.**
"Same engine on a phone today, on body cams, drones and glasses next. Local
intelligence for the physical world, for when the stakes are high and the
connection isn't there."

## If something goes wrong

- **Camera or model misbehaves:** *Change source* then *Simulated building*.
  It is the same reasoning engine on scripted detections, clearly labelled
  SIMULATED. It still makes the offline point, because the pills stay
  *Offline / On-device / 0 sent*.
- **The answer is wrong:** say so. Show the evidence and correct it with
  *Not this* or *Blocked*. A system that takes correction live is a stronger
  demo than one that pretends to be perfect.

## Questions judges ask

- **"How do I know it's really local?"** Airplane mode, on stage. And the
  browser enforces it: the Content-Security-Policy only allows connections to
  the app's own origin, and the service worker counts every network request.
  The counter is the "0 sent" pill.
- **"What if it hallucinates an exit?"** It can't invent one. No language
  model writes answers. An exit exists only if a door or exit sign was
  detected, and a hazard seen in a single frame is reported as unconfirmed.
- **"How accurate is it?"** Be precise. It matches the reference detector
  box-for-box. Its false-alarm rate on ordinary scenes is measured (3.9% of
  photos at its threshold). Hazard *recall* in real damaged buildings is not
  measured yet, and collecting that footage is the next step.
- **"Why not just a bigger cloud model?"** Because the building that needs
  this is the one with no signal, and the patient, plant or site that needs
  it is often the one whose images can't leave the room.
