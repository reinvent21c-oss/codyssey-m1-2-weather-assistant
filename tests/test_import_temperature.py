"""Importer tests use the real local CSV and Mock Firestore only."""

import csv
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from google.api_core.exceptions import AlreadyExists

from scripts import import_temperature as importer


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.records, self.validation = importer.validate_csv()
        self.stored = {}
        self.client = Mock()
        self.client.project = "test-project"
        self.collection = self.client.collection.return_value
        self.references = {}
        self.collection.document.side_effect = self.reference

    def reference(self, document_id):
        if document_id not in self.references:
            reference = Mock()
            reference.id = document_id

            def get():
                snapshot = Mock()
                snapshot.exists = document_id in self.stored
                snapshot.to_dict.return_value = self.stored.get(document_id)
                return snapshot

            def create(payload):
                if document_id in self.stored:
                    raise AlreadyExists("private SDK details")
                self.stored[document_id] = payload.copy()

            reference.get.side_effect = get
            reference.create.side_effect = create
            self.references[document_id] = reference
        return self.references[document_id]

    def run_cli(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = importer.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def apply(self):
        return importer.inspect_or_import(
            self.records, self.client, "test-project", apply=True, confirmed_project_id="test-project"
        )

    def assert_no_writes(self):
        for reference in self.references.values():
            reference.create.assert_not_called()
            reference.set.assert_not_called()
            reference.update.assert_not_called()
            reference.delete.assert_not_called()
        self.client.batch.assert_not_called()

    def mutated_csv(self, mutate):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        path = Path(directory) / "data.csv"
        with importer.CSV_PATH.open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream))
        mutate(rows)
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=["date", "value", "memo"])
            writer.writeheader()
            writer.writerows(rows)
        return path

    def test_real_csv_365_and_report(self):
        self.assertEqual(len(self.records), 365)
        self.assertEqual(self.records[0].date, "2025-10-01")
        self.assertEqual(self.records[-1].date, "2026-09-30")
        self.assertEqual(self.validation["mean_celsius_rounded"], "14.24")
        self.assertEqual(self.validation["min_celsius"], "-9.7")
        self.assertEqual(self.validation["max_celsius"], "33.1")

    def test_duplicate_date(self):
        path = self.mutated_csv(lambda rows: rows[1].update(date=rows[0]["date"]))
        with self.assertRaises(importer.InputValidationError):
            importer.validate_csv(path)

    def test_missing_date(self):
        path = self.mutated_csv(lambda rows: rows.pop())
        with self.assertRaises(importer.InputValidationError):
            importer.validate_csv(path)

    def test_bad_values_and_dates(self):
        for field, value in (("value", ""), ("value", "NaN"), ("value", "Infinity"), ("value", "abc"), ("value", "1e200"), ("date", "2025-02-30"), ("date", "2027-01-01")):
            with self.subTest(field=field, value=value):
                path = self.mutated_csv(lambda rows: rows[0].update({field: value}))
                with self.assertRaises(importer.InputValidationError):
                    importer.validate_csv(path)

    def test_wrong_columns_and_non_utf8(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        path = Path(directory) / "data.csv"
        for contents in (b"date,value\n", b"date,value,memo\n2025-10-01,1,\xff\n"):
            with self.subTest(contents=contents):
                path.write_bytes(contents)
                with self.assertRaises(importer.InputValidationError):
                    importer.validate_csv(path)

    def test_report_mismatch_blocks_import(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        path = Path(directory) / "validation.json"
        path.write_text(json.dumps({**self.validation, "mean_celsius_rounded": "99"}), encoding="utf-8")
        with self.assertRaisesRegex(importer.InputValidationError, "validation.json"):
            importer.validate_csv(validation_path=path)

    def test_local_mode_has_no_firebase_calls_or_writes(self):
        with patch.object(importer, "connect_target") as connect, patch.object(importer, "inspect_or_import") as remote, patch("backend.firebase.get_firebase_app") as app, patch("backend.firebase.get_firestore_client") as client, patch.dict(os.environ, {}, clear=True):
            code, output, errors = self.run_cli([])
        self.assertEqual(code, 0)
        self.assertEqual(errors, "")
        result = json.loads(output)
        self.assertEqual((result["remote_reads"], result["remote_writes"]), (0, 0))
        self.assertEqual(result["planned_records"], 365)
        for operation in (connect, remote, app, client):
            operation.assert_not_called()

    def test_invalid_input_stops_before_connection_even_with_apply(self):
        with patch.object(importer, "validate_csv", side_effect=importer.InputValidationError("Invalid CSV")), patch.object(importer, "connect_target") as connect:
            code, _, _ = self.run_cli(["--apply", "--project-id", "test-project", "--confirm-project-id", "test-project"])
        self.assertEqual(code, 1)
        connect.assert_not_called()

    def test_apply_requires_confirmation_before_connection(self):
        for args in (["--apply"], ["--apply", "--project-id", "test-project"], ["--apply", "--project-id", "test-project", "--confirm-project-id", "other"]):
            with self.subTest(args=args), patch.object(importer, "connect_target") as connect:
                code, _, _ = self.run_cli(args)
                self.assertEqual(code, 1)
                connect.assert_not_called()

    def test_helper_without_apply_is_read_only(self):
        result = importer.inspect_or_import(self.records, self.client, "test-project")
        self.assertEqual(result.pending, 365)
        self.assertEqual(result.created, 0)
        self.assert_no_writes()

    def test_remote_cli_is_read_only(self):
        with patch.object(importer, "connect_target", return_value=self.client):
            code, output, errors = self.run_cli(["--check-remote", "--project-id", "test-project"])
        self.assertEqual(code, 0)
        self.assertEqual(errors, "")
        self.assertEqual(json.loads(output)["mode"], "check_remote")
        self.assert_no_writes()

    def test_client_project_and_confirmation_mismatch(self):
        for project, confirm in (("other", "other"), ("test-project", None)):
            with self.subTest(project=project, confirm=confirm):
                with self.assertRaises(importer.InputValidationError):
                    importer.inspect_or_import(self.records, self.client, project, apply=True, confirmed_project_id=confirm)
        self.client.collection.assert_not_called()

    def test_environment_project_mismatch_before_sdk_initialization(self):
        with patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "other"}, clear=True), patch("dotenv.load_dotenv"), patch("backend.firebase.get_firebase_app") as app, patch("backend.firebase.get_firestore_client") as client:
            with self.assertRaises(importer.InputValidationError):
                importer.connect_target("test-project")
            app.assert_not_called()
            client.assert_not_called()

    def test_cached_app_and_client_project_mismatches(self):
        for app_project, client_project in (("other", "test-project"), ("test-project", "other")):
            with self.subTest(app=app_project, client=client_project), patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "test-project"}, clear=True), patch("dotenv.load_dotenv"), patch("backend.firebase.get_firebase_app", return_value=Mock(project_id=app_project)), patch("backend.firebase.get_firestore_client", return_value=Mock(project=client_project)):
                with self.assertRaises(importer.InputValidationError):
                    importer.connect_target("test-project")

    def test_new_records_created_only_after_complete_preflight(self):
        first = self.reference(self.records[0].date)
        original_create = first.create.side_effect

        def create(payload):
            self.assertEqual(len(self.references), 365)
            self.assertTrue(all(reference.get.call_count == 1 for reference in self.references.values()))
            original_create(payload)

        first.create.side_effect = create
        result = self.apply()
        self.assertEqual((result.created, result.failed, result.conflicts, result.pending), (365, 0, 0, 0))
        self.assertEqual(result.status, "complete")
        self.assertEqual(len(self.stored), 365)
        self.assertTrue(all(call.args == ("data",) for call in self.client.collection.call_args_list))
        for reference in self.references.values():
            reference.create.assert_called_once()
            reference.set.assert_not_called()
            reference.update.assert_not_called()
            reference.delete.assert_not_called()

    def test_identical_data_is_skipped_on_rerun(self):
        self.stored.update({record.date: record.model_dump() for record in self.records})
        for _ in range(2):
            result = self.apply()
            self.assertEqual((result.created, result.existing_identical, result.pending), (0, 365, 0))
        self.assert_no_writes()

    def test_preexisting_conflict_anywhere_blocks_all_writes(self):
        record = self.records[-1]
        self.stored[record.date] = {**record.model_dump(), "value": 999}
        result = self.apply()
        self.assertEqual((result.created, result.conflicts, result.pending), (0, 1, 364))
        self.assertEqual(result.conflict_dates, [record.date])
        self.assert_no_writes()
        self.assertEqual(self.stored[record.date]["value"], 999)

    def test_memo_or_extra_field_is_a_conflict(self):
        record = self.records[0]
        for changes in ({"memo": "different"}, {"extra": "value"}, {"value": True}):
            with self.subTest(changes=changes):
                self.stored[record.date] = {**record.model_dump(), **changes}
                result = self.apply()
                self.assertEqual(result.conflicts, 1)
                self.assertEqual(result.created, 0)
        self.assert_no_writes()

    def test_preflight_read_failure_blocks_all_writes(self):
        record = self.records[100]
        self.reference(record.date).get.side_effect = RuntimeError("private SDK details")
        result = self.apply()
        self.assertEqual((result.created, result.failed), (0, 1))
        self.assertEqual(result.failed_dates, [record.date])
        self.assert_no_writes()

    def test_partial_failure_then_safe_rerun(self):
        failing = self.reference(self.records[5].date)
        original_create = failing.create.side_effect
        failing.create.side_effect = RuntimeError("private SDK details")
        first = self.apply()
        self.assertEqual((first.created, first.failed, first.pending), (5, 1, 359))
        failing.create.side_effect = original_create
        second = self.apply()
        self.assertEqual((second.created, second.existing_identical, second.failed), (360, 5, 0))
        self.assertEqual(len(self.stored), 365)

    def test_timeout_after_commit_reconciles_on_rerun(self):
        failing = self.reference(self.records[5].date)

        def uncertain_commit(payload):
            self.stored[failing.id] = payload.copy()
            raise TimeoutError("private SDK details")

        failing.create.side_effect = uncertain_commit
        first = self.apply()
        self.assertEqual((first.created, first.failed), (5, 1))
        second = self.apply()
        self.assertEqual((second.created, second.existing_identical, second.failed), (359, 6, 0))

    def test_concurrent_identical_create_is_skipped(self):
        record = self.records[0]

        def raced(payload):
            self.stored[record.date] = payload.copy()
            raise AlreadyExists("private SDK details")

        self.reference(record.date).create.side_effect = raced
        result = self.apply()
        self.assertEqual((result.created, result.existing_identical, result.failed), (364, 1, 0))

    def test_concurrent_different_create_stops_remaining_writes(self):
        record = self.records[0]

        def raced(payload):
            self.stored[record.date] = {**payload, "value": 999}
            raise AlreadyExists("private SDK details")

        self.reference(record.date).create.side_effect = raced
        result = self.apply()
        self.assertEqual((result.created, result.conflicts, result.pending), (0, 1, 364))
        self.assertEqual(len(self.stored), 1)

    def test_errors_do_not_expose_credentials_or_internal_details(self):
        with patch.object(importer, "connect_target", side_effect=RuntimeError("PRIVATE_CREDENTIAL_SENTINEL")):
            code, output, errors = self.run_cli(["--check-remote", "--project-id", "test-project"])
        self.assertEqual(code, 1)
        self.assertNotIn("PRIVATE_CREDENTIAL_SENTINEL", output + errors)
        self.reference(self.records[0].date).create.side_effect = RuntimeError("PRIVATE_CREDENTIAL_SENTINEL")
        with patch.object(importer, "connect_target", return_value=self.client):
            code, output, errors = self.run_cli(["--apply", "--project-id", "test-project", "--confirm-project-id", "test-project"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failed"], 1)
        self.assertNotIn("PRIVATE_CREDENTIAL_SENTINEL", output + errors)


if __name__ == "__main__":
    unittest.main()
