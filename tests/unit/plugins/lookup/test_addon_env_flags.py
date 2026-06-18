import unittest
from unittest.mock import patch

from ansible.errors import AnsibleError

from plugins.lookup.addon_env_flags import LookupModule, env_key


class TestEnvKey(unittest.TestCase):
    """env_key() must match addon-gating.js envKey() exactly."""

    def test_simple(self):
        self.assertEqual(env_key("collectives"), "COLLECTIVES_ADDON_ENABLED")

    def test_underscores_preserved(self):
        self.assertEqual(env_key("files_bpm"), "FILES_BPM_ADDON_ENABLED")
        self.assertEqual(
            env_key("integration_gitlab"), "INTEGRATION_GITLAB_ADDON_ENABLED"
        )

    def test_non_alnum_runs_collapse(self):
        self.assertEqual(
            env_key("ldap-authenticator"), "LDAP_AUTHENTICATOR_ADDON_ENABLED"
        )
        self.assertEqual(env_key("a.b-c"), "A_B_C_ADDON_ENABLED")


class TestAddonEnvFlagsLookup(unittest.TestCase):
    def setUp(self):
        self.lookup = LookupModule()
        self.addons = {
            "collectives": {"enabled": True, "required": True},
            "contacts": {"enabled": True, "required": True},
            "optional_on": {"enabled": True, "required": False},
            "required_off": {"enabled": False, "required": True},
            "off_optional": {"enabled": False, "required": False},
            "str_flags": {"enabled": "true", "required": "true"},
            "no_required": {"enabled": True},
        }
        self._patchers = [
            patch(
                "plugins.lookup.addon_env_flags.get_merged_applications",
                return_value={},
            ),
            patch("plugins.lookup.addon_env_flags.get", return_value=self.addons),
            patch(
                "plugins.lookup.addon_env_flags._render_with_templar",
                side_effect=lambda v, **k: v,
            ),
        ]
        for p in self._patchers:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self._patchers])

    def _flags(self):
        out = self.lookup.run(["web-app-x"], variables={})[0]
        return dict(line.split("=", 1) for line in out.splitlines())

    def test_enabled_and_required_true(self):
        f = self._flags()
        self.assertEqual(f["COLLECTIVES_ADDON_ENABLED"], "true")
        self.assertEqual(f["CONTACTS_ADDON_ENABLED"], "true")

    def test_required_false_skipped_even_if_enabled(self):
        self.assertEqual(self._flags()["OPTIONAL_ON_ADDON_ENABLED"], "false")

    def test_disabled_is_false(self):
        f = self._flags()
        self.assertEqual(f["REQUIRED_OFF_ADDON_ENABLED"], "false")
        self.assertEqual(f["OFF_OPTIONAL_ADDON_ENABLED"], "false")

    def test_missing_required_defaults_false(self):
        self.assertEqual(self._flags()["NO_REQUIRED_ADDON_ENABLED"], "false")

    def test_string_flags_coerced(self):
        self.assertEqual(self._flags()["STR_FLAGS_ADDON_ENABLED"], "true")

    def test_one_line_per_addon_sorted_by_key(self):
        lines = self.lookup.run(["web-app-x"], variables={})[0].splitlines()
        self.assertEqual(len(lines), len(self.addons))
        keys = [ln.split("=", 1)[0] for ln in lines]
        self.assertEqual(keys, sorted(keys))

    def test_no_terms_raises(self):
        with self.assertRaises(AnsibleError):
            self.lookup.run([], variables={})

    def test_too_many_terms_raises(self):
        with self.assertRaises(AnsibleError):
            self.lookup.run(["a", "b"], variables={})


class TestNoAddons(unittest.TestCase):
    def test_empty_addons_yields_empty_string(self):
        lookup = LookupModule()
        with (
            patch(
                "plugins.lookup.addon_env_flags.get_merged_applications",
                return_value={},
            ),
            patch("plugins.lookup.addon_env_flags.get", return_value={}),
            patch(
                "plugins.lookup.addon_env_flags._render_with_templar",
                side_effect=lambda v, **k: v,
            ),
        ):
            self.assertEqual(lookup.run(["web-app-x"], variables={}), [""])


if __name__ == "__main__":
    unittest.main()
