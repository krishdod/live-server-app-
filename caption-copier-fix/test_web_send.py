import ast
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace as NS
import threading
import unittest

source = Path(__file__).with_name('simple_caption_tool.py').read_text(encoding='utf-8')
names = {'_is_chatgpt_composer', '_focus_verified_composer', '_read_input_text',
         '_find_chatgpt_input_control', '_paste_and_submit_to_input', '_execute_send_to_chatgpt', '_send_failed'}
module = ast.Module(body=[n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[])

class Field:
    IsOffscreen = False
    IsEnabled = True
    ControlTypeName = 'EditControl'
    AutomationId = 'prompt-textarea'
    Name = 'Ask anything'
    def __init__(self):
        self.text = ''
        self.keys = []
        self.clipboard = ''
    def SetFocus(self): pass
    def Click(self, **kwargs): pass
    def GetValuePattern(self): return NS(Value=self.text)
    def SendKeys(self, key, **kwargs):
        self.keys.append(key)
        if key == '{Ctrl}v': self.text = self.clipboard
        if key == '{Enter}': self.text = ''

class SendTests(unittest.TestCase):
    def setUp(self):
        self.field = Field()
        self.clock = 0
        def now():
            self.clock += .1
            return self.clock
        self.env = dict(UIA_AVAILABLE=True, WIN32_AVAILABLE=False, chatgpt_hwnd=123,
            chatgpt_input_ctrl=None, chatgpt_window_title='ChatGPT - Chrome',
            _last_send_detail='',
            time=NS(sleep=lambda _: None, monotonic=now),
            _clipboard_send_lock=threading.Lock(), _chatgpt_send_lock=threading.Lock(),
            pyperclip=NS(copy=lambda text: setattr(self.field, 'clipboard', text)),
            uia=NS(UIAutomationInitializerInThread=nullcontext,
                ControlFromHandle=lambda _: object(), WalkControl=lambda *a, **k: [(self.field, 2)],
                GetFocusedControl=lambda: self.field, ControlsAreSame=lambda a,b: a is b))
        exec(compile(module, 'send-functions', 'exec'), self.env)
    def test_address_bar_and_page_document_are_rejected(self):
        for kind, aid, name in [('EditControl', '', 'Address and search bar'),
                                ('DocumentControl', '', 'ChatGPT'), ('EditControl', '', 'Search')]:
            self.field.ControlTypeName, self.field.AutomationId, self.field.Name = kind, aid, name
            self.assertIsNone(self.env['_find_chatgpt_input_control'](123))
    def test_focus_failure_sends_no_keys(self):
        self.env['uia'].GetFocusedControl = lambda: object()
        self.assertFalse(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, [])
    def test_existing_draft_is_not_destroyed(self):
        self.field.text = 'my draft'
        self.assertFalse(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.text, 'my draft')
        self.assertEqual(self.field.keys, [])
    def test_targeted_click_recovers_ignored_set_focus(self):
        focused = [object()]
        self.env['uia'].GetFocusedControl = lambda: focused[0]
        self.field.Click = lambda **kwargs: focused.__setitem__(0, self.field)
        self.assertTrue(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, ['{Ctrl}v', '{Enter}'])
    def test_verified_paste_submits_exactly_once(self):
        self.assertTrue(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, ['{Ctrl}v', '{Enter}'])
    def test_failed_paste_never_presses_enter(self):
        self.env['pyperclip'].copy = lambda _: None
        self.assertFalse(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, ['{Ctrl}v'])
    def test_accessibility_label_is_not_draft_text(self):
        self.assertEqual(self.env['_read_input_text'](self.field), '')
    def test_chrome_ask_chatgpt_placeholder_can_send(self):
        self.field.Name = 'Ask ChatGPT'
        self.field.text = 'Ask ChatGPT'
        self.assertTrue(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, ['{Ctrl}v', '{Enter}'])
    def test_placeholder_word_inside_actual_draft_is_preserved(self):
        self.field.Name = 'Ask ChatGPT'
        self.field.text = 'Ask ChatGPT about Python'
        self.assertFalse(self.env['_paste_and_submit_to_input']('hello'))
        self.assertEqual(self.field.keys, [])
    def test_no_global_keyboard_fallback(self):
        actions = []
        self.env.update(_force_foreground=lambda _: True,
            _paste_and_submit_to_input=lambda _: False,
            root=NS(after=lambda ms, fn: fn()),
            status_label=NS(config=lambda **k: actions.append(k['text'])),
            _set_last_action=lambda _: None)
        self.env['_execute_send_to_chatgpt']('caption')
        self.assertTrue(actions[0].startswith('Not sent'))
        self.assertEqual(self.field.keys, [])

if __name__ == '__main__': unittest.main()
