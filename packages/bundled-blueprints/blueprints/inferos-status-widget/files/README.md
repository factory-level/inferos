# Status Widget

A sample widget with local states (FAC-86): one piece of work that is idle, working, done or
failed, with retry. It needs no binding and reads and changes nothing outside itself.

## States

`states.json` declares them. Publishing a console freezes them with the widget's install, and each
person's state is kept for that console revision (`persistence: "person"`):

| From | Event | To |
| --- | --- | --- |
| idle | start | working |
| working | finish | done |
| working | fail | failed |
| failed | retry | working |
| done, failed | reset | idle |

In Operate, the console shows the current state above the widget and offers only the events it
accepts from there. The host also tells the widget its state (a `widget-state` message), and the
widget's header mark, the InferOS mark, takes that state's colour. Outside Operate it says so, and
the mark stays neutral.
