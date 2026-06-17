# GNOME Extensions Manager

## Description

This role manages GNOME Shell extensions by ensuring user extensions are enabled and by installing the CLI GNOME Extension Manager. The CLI tool facilitates the configuration and control of GNOME extensions via the command line.

Learn more about the CLI tool on its [GitHub page](https://github.com/kevinveenbirkenbach/cli-gnome-extension-manager) and about GNOME Extensions at [GNOME Extensions](https://extensions.gnome.org).

## Overview

This role configures GNOME Shell extensions and installs the CLI GNOME Extension Manager for managing extensions.

## Purpose

The purpose of this role is to enhance and customize the GNOME desktop environment by managing shell extensions. It simplifies the process of installing and configuring extensions, thereby improving productivity and desktop functionality.

## Features

- Activates GNOME Shell extensions via gsettings.
- Installs the CLI GNOME Extension Manager using the package manager.
- Executes extension configuration commands for streamlined management.
- Provides an automated method for managing and updating GNOME extensions.

## Addons

This role is a generic GNOME-extension installer driven by `services.gnome-extensions.plugins`, a 3-tuple list (`action`, `uuid`, `url`) consumed by `cli-gnome-extension-manager`.
It ships no concrete extensions of its own and reads no `meta/addons/` files.
Roles that ship concrete GNOME extensions, such as [desk-gnome](../desk-gnome/), declare them through the unified addon contract under `meta/addons/` (requirement 026), with one file per extension (`mechanism: extension`, `source: upstream`, `config: { uuid, url }`); see that role for the per-file example.

Playwright exemption: GNOME Shell extensions are desktop-only and have no in-app web surface to drive, so they carry no Playwright spec (Confirmed Decision 11).

## Credits

Developed and maintained by **Kevin Veen-Birkenbach**.
Learn more at [veen.world](https://www.veen.world).
Part of the [Infinito.Nexus Project](https://s.infinito.nexus/code).
Licensed under the [Infinito.Nexus Community License (Non-Commercial)](https://s.infinito.nexus/license).
