# jpi-guardian (deprecated)

This plugin moved into the consolidated [jpi](https://github.com/josh-sola/jpi)
plugin as its `guardian` module. This repo now ships only a startup warning.

To switch:

```
pi install git:github.com/josh-sola/jpi
pi remove git:github.com/josh-sola/jpi-guardian
```

The module can be disabled via `enabled #false` in the `guardian { }` stanza of
`jpi.kdl`.
