# Idee für delta streams

TODO beispiel json, beispiel delta, reactive ui, diffing logic?,
# delta compression logic
addDeltas: (first: Delta second: Delta) -> Delta

# use cases
1. reactive ui
	?dom delta
2. game logic
3. client-server communication  
	client holt einmal current, ab dann nur noch deltas
	?delta mit auto increment id oder timestamp (unix epoch)
4. database?
5. caching?

