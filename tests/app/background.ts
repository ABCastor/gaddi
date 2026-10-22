import assert from 'node:assert/strict';
import fs from 'node:fs';

let controller = fs.readFileSync(new URL('../../app/Sources/AppController.swift', import.meta.url), 'utf8');
if (process.argv[2] === 'AUTO_FOCUS') {
  const automatic = 'requestedID = nil\n            showApprovals()';
  assert.ok(controller.includes(automatic), 'automatic presentation mutation exists');
  controller = controller.replace(automatic, 'requestedID = nil\n            openApprovals()');
}
// Comments cannot satisfy a presentation or activation check.
controller = controller.replace(/^\s*\/\/[^\n]*/gm, '');
const main = fs.readFileSync(new URL('../../app/Sources/main.swift', import.meta.url), 'utf8');
const body = (start: string, end: string) => controller.slice(controller.indexOf(start), controller.indexOf(end, controller.indexOf(start)));
const notify = body('private func notify(', 'func userNotificationCenter');
assert.match(notify, /UNUserNotificationCenter.current\(\).add/);
assert.doesNotMatch(notify, /openApprovals|activate|makeKeyAndOrderFront/);
assert.doesNotMatch(body('private func render()', '@objc private func quit()'), /openApprovals\(\)|NSApp\.activate|makeKeyAndOrderFront/);
assert.doesNotMatch(body('private func renderApprovals()', 'private func notify('), /openApprovals\(\)|NSApp\.activate|makeKeyAndOrderFront/);
const error = body('private func showError(', 'private func authenticated(');
assert.match(error, /errorText =/);
assert.match(error, /render\(\)/);
assert.doesNotMatch(error, /NSAlert|runModal|openApprovals|activate|makeKeyAndOrderFront/);
assert.equal((controller.match(/NSApp.activate\(/g) || []).length, 1);
assert.match(body('@objc private func openApprovals(', 'private func renderApprovals('), /NSApp.activate/);
assert.match(body('didReceive response:', 'private func showError('), /self.requestApproval\(id\)/);
assert.match(controller, /#selector\(openApprovals\)/);
assert.doesNotMatch(body('private func requestApproval(', 'func applicationDidFinishLaunching'), /openApprovals|activate|authenticate/);
const pending = body('private func presentPendingApprovals()', '@objc private func openApprovals()');
assert.match(pending, /snapshot.approvals.contains\(where: \{ \$0.id == id && !\$0.expired \}\)/);
assert.match(pending, /visibility.shouldPresent\(snapshot.approvals, busy: busy\)/);
assert.doesNotMatch(pending, /authenticate|authenticated|decide\(/);
const automatic = pending.slice(pending.indexOf('if visibility.shouldPresent'));
assert.doesNotMatch(automatic, /openApprovals\(|NSApp\.activate|makeKey/,
  'automatic approval presentation must not take focus');
assert.match(automatic, /showApprovals\(\)/);
const show = body('private func showApprovals()', 'private func renderApprovals()');
assert.match(show, /orderFrontRegardless\(\)/);
assert.match(show, /styleMask: \[[^\]]*\.nonactivatingPanel/);
assert.match(show, /panel.hidesOnDeactivate = false/);
assert.doesNotMatch(show, /NSApp\.activate|makeKey/);
assert.match(body('@objc private func openApprovals()', 'private func showApprovals()'), /makeKeyAndOrderFront/);
assert.match(pending.slice(0, pending.indexOf('if visibility.shouldPresent')), /openApprovals\(\)/);
assert.match(body('model.onSnapshot =', 'model.onPending ='), /presentPendingApprovals\(\)/);
assert.equal((controller.match(/statusItem.menu =/g) || []).length, 1, 'the tracking menu is installed once');
assert.doesNotMatch(body('private func render()', '@objc private func quit()'), /statusItem.menu =|NSMenu\(/, 'polls update the existing tracking menu');
assert.match(pending, /visibility.shouldDismiss\(snapshot.approvals, connected: connected, busy: busy, hasError: errorText != nil\)/);
assert.match(pending, /approvalsPanel\?\.orderOut\(nil\)/);
assert.match(body('private func showApprovals()', 'private func renderApprovals()'), /visibility.opened\(snapshot.approvals, preservingCurrentMode: approvalsPanel\?\.isVisible == true\)/);
assert.match(body('@objc private func openApprovals()', 'private func showApprovals()'), /visibility.opened\(snapshot.approvals\)/);
assert.doesNotMatch(main, /existing.activate/);
assert.ok(main.indexOf('if arguments == ["--headless-check"]') < main.indexOf('let application = NSApplication.shared'));
const open = body('@objc private func openApprovals()', 'private func showApprovals()');
assert.match(open, /approvalsPanel\?\.level = \.floating[\s\S]*reviewFloat\.opened\(\)/, 'an opened review floats and starts its float rule');
assert.match(open, /NSEvent\.addGlobalMonitorForEvents\(matching: \[\.leftMouseDown, \.rightMouseDown, \.otherMouseDown\]\)[\s\S]*reviewFloat\.clickedInOtherApp\(\)[\s\S]*stopFloating\(\)/,
  'ASSERT_REVIEW_YIELDS: a click in another app drops the floating review');
assert.match(controller, /addObserver\(self, selector: #selector\(otherAppActivated\(_:\)\),\s*name: NSWorkspace\.didActivateApplicationNotification/,
  'ASSERT_REVIEW_YIELDS: switching apps is observed');
assert.match(body('@objc private func otherAppActivated(', 'private func stopFloating()'), /reviewFloat\.otherAppActivated\(\)[\s\S]*stopFloating\(\)/,
  'ASSERT_REVIEW_YIELDS: an app switch after the handback grace drops the floating review');
assert.match(body('private func stopFloating()', 'func windowWillClose('), /approvalsPanel\?\.level = \.normal[\s\S]*NSEvent\.removeMonitor/,
  'ASSERT_REVIEW_YIELDS: dropping returns the window to a normal level and stops watching clicks');
assert.match(body('func windowWillClose(', 'func applicationShouldHandleReopen('), /reviewFloat\.closed\(\); stopFloating\(\)/);
assert.equal((controller.match(/\.level = \.floating/g) || []).length, 1, 'only an explicit open floats the review');
console.log('PASS app background: automatic pending snapshots show a nonactivating panel without making it key; explicit opens still activate');
