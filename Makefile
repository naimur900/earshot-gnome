UUID    = earshot@naimur
SRC     = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP     = $(UUID).shell-extension.zip

# Virtualenv for the shexli analyzer: outside git, reused since it hits the network.
SHEXLI_VENV = .shexli-venv

# Modules besides extension.js, which `gnome-extensions pack` takes on its own.
MODULES = bluez.js compat.js headphones.js noise.js profile.js quickToggle.js session.js

.PHONY: all install uninstall enable disable pack check test shexli clean-shexli logs clean

all: check

install:
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(SRC)/. $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Now log out and back in (Wayland), then: make enable"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Syntax-checks every module without a running shell.
check:
	@for f in $(SRC)/*.js $(SRC)/backends/*.js; do \
		node --check "$$f" >/dev/null 2>&1 && echo "ok   $$f" || { echo "FAIL $$f"; node --check "$$f"; exit 1; }; \
	done
	@python3 -c "import json,sys;m=json.load(open('$(SRC)/metadata.json'));miss=[k for k in ('uuid','name','description','shell-version','url') if not m.get(k)];sys.exit('FAIL metadata.json missing: '+', '.join(miss)) if miss else None" && echo "ok   metadata.json"

# Protocol tests against frames captured from real earbuds; no shell or
# Bluetooth needed.
test:
	gjs -m tests/oppo.test.js
	gjs -m tests/backends.test.js

pack:
	rm -f $(ZIP)
	gnome-extensions pack $(SRC) \
		$(foreach m,$(MODULES),--extra-source=$(m)) \
		--extra-source=backends \
		--extra-source=icons \
		"--extra-source=$(CURDIR)/LICENSE" \
		--force

# EGO review checks, run against a freshly packed zip (the actual upload).
shexli: pack | $(SHEXLI_VENV)/.installed
	@$(SHEXLI_VENV)/bin/shexli "$(CURDIR)/$(ZIP)"

# tree-sitter 0.26 segfaults with shexli's 0.25 JavaScript grammar. The sentinel
# is written only on success, so a failed install is retried.
$(SHEXLI_VENV)/.installed:
	python3 -m venv $(SHEXLI_VENV)
	$(SHEXLI_VENV)/bin/pip install --upgrade pip
	$(SHEXLI_VENV)/bin/pip install --upgrade shexli 'tree-sitter<0.26'
	@touch $@
	@echo "shexli environment ready in $(SHEXLI_VENV)"

clean-shexli:
	rm -rf $(SHEXLI_VENV)

# Live extension logs. Ctrl-C to stop.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "earshot"

clean:
	rm -f $(ZIP)
