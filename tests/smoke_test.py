"""
End-to-end smoke test against a temporary SQLite database.

Run with:  python tests/smoke_test.py

It exercises the full product flow through Flask's test client: registration,
business isolation between managers, staff/roles/shifts persistence, async
schedule generation, publishing, the employee portal (login, availability,
time off, shift swaps), the anonymous demo, and the forgot-password loop.
"""

import os
import sys
import tempfile
import time
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

tmp = tempfile.mkdtemp()
os.environ['DATABASE_URL'] = 'sqlite:///' + os.path.join(tmp, 'test.db').replace('\\', '/')
os.environ['SECRET_KEY'] = 'test'
os.environ.pop('RESEND_API_KEY', None)
os.environ.pop('MAIL_USERNAME', None)

from app import app  # noqa: E402
from models import db, User, PasswordResetToken, DBEmployee  # noqa: E402
from routes.manager_api import create_or_get_employee_user  # noqa: E402

app.config['TESTING'] = True
FAILS = []


def j(resp):
    try:
        return resp.get_json()
    except Exception:
        return None


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def wait_job(client, job_id, timeout=60):
    t = time.time()
    d = None
    while time.time() - t < timeout:
        d = j(client.get(f'/api/schedule/job/{job_id}'))
        if d and d['status'] in ('done', 'failed'):
            return d
        time.sleep(0.5)
    return d


def main():
    c = app.test_client()

    print("== register manager A")
    r = c.post('/auth/register', json=dict(email='a@test.com', username='alice', password='password123',
                                           confirm_password='password123', first_name='Alice', company_name='Alice Cafe'))
    d = j(r)
    check(r.status_code == 200 and d['success'], f"register -> {r.status_code} {d}")
    check(d['redirect'] == '/alice-cafe/schedule', f"redirect {d['redirect']}")
    d = j(c.get('/api/businesses'))
    check(len(d['businesses']) == 1 and d['businesses'][0]['slug'] == 'alice-cafe', f"businesses {d}")
    biz_id = d['businesses'][0]['id']
    r = c.get('/alice-cafe/schedule')
    check(r.status_code == 200 and b'Demo Locations' not in r.data, f"manager page {r.status_code}")
    r = c.get('/sunrise-coffee/schedule')
    check(r.status_code == 302 and '/alice-cafe/schedule' in r.headers['Location'],
          f"demo slug redirects home: {r.status_code} {r.headers.get('Location')}")

    print("== employees + roles persist")
    d = j(c.post('/api/employees', json=dict(name='Bob Barista', email='bob@test.com', roles=['staff'],
                                             min_hours=10, max_hours=30, businessId=biz_id)))
    check(d and d['success'], f"add employee {d}")
    bob_id = d['employee']['id']
    d = j(c.put(f'/api/employees/{bob_id}', json=dict(roles=['staff', 'manager'], can_supervise=True)))
    check(d['success'] and set(d['employee']['roles']) == {'staff', 'manager'}, f"update roles {d.get('employee', {}).get('roles')}")
    d = j(c.get('/api/employees'))
    bob = [e for e in d['employees'] if e['id'] == bob_id][0]
    check(set(bob['roles']) == {'staff', 'manager'} and bob['db_id'], f"roles persisted after fresh load: {bob['roles']} db_id={bob['db_id']}")
    d = j(c.post(f'/api/{biz_id}/settings/roles', json=dict(name='Cook', color='#123456')))
    check(d['success'], "add role by id ref")
    cook = d['role']['id']
    d = j(c.post('/api/alice-cafe/settings/roles', json=dict(name='Host')))
    check(d['success'], "add role by slug ref")
    d = j(c.post('/api/settings/shifts', json=dict(name='Dinner', start_hour=13, end_hour=17,
                                                   roles=[dict(role_id=cook, count=1)], days=[0, 1, 2, 3, 4])))
    check(d['success'], "add shift template")
    d = j(c.get('/api/settings/shifts'))
    check(len(d['shifts']) == 3, f"shift templates persisted: {len(d['shifts'])}")
    d = j(c.put('/api/settings', json=dict(hours=dict(start_hour=8, end_hour=18), days_open=[0, 1, 2, 3, 4, 5])))
    check(d['success'], f"settings hours {d}")
    d = j(c.get('/api/settings'))
    check(d['settings']['hours']['start_hour'] == 8 and d['settings']['days_open'] == [0, 1, 2, 3, 4, 5], "hours persisted")

    print("== generate schedule (async job)")
    d = j(c.post('/api/generate', json=dict(businessId=biz_id, weekOffset=0, policies=dict(min_shift_length=2))))
    check(d['success'] and d.get('job_id'), f"job started {d}")
    d = wait_job(c, d['job_id'])
    check(d['status'] == 'done', f"job status {d['status']} msg={d.get('message')} err={d.get('error')}")
    res = d.get('result') or {}
    check(res.get('success'), f"schedule feasible: {res.get('message')}")
    sched = res.get('schedule', {})
    print("       coverage:", sched.get('coverage_percentage'), "assignments:", len(sched.get('assignments', [])),
          "suggestions:", sched.get('metrics', {}).get('suggestions'))
    d = j(c.get(f'/api/schedule/load?businessId={biz_id}&weekOffset=0'))
    check(d['success'] and d['status'] == 'draft', f"load saved {d.get('status')}")
    d = j(c.post('/api/alternative', json=dict(businessId=biz_id, weekOffset=0)))
    d = wait_job(c, d['job_id'])
    check(d['status'] == 'done' and d['result']['success'], f"alternative {d.get('message')}")
    d = j(c.post('/api/schedule/publish', json=dict(businessId=biz_id, weekOffset=0)))
    check(d['success'], f"publish {d}")
    d = j(c.get(f'/api/schedule/load?businessId={biz_id}&weekOffset=0'))
    check(d['status'] == 'published', f"status after publish {d.get('status')}")

    print("== isolation: manager B cannot see A")
    c2 = app.test_client()
    d = j(c2.post('/auth/register', json=dict(email='b@test.com', username='bobby', password='password123',
                                              confirm_password='password123', company_name='Alice Cafe')))
    check(d['success'], "register B with same company name")
    r = c2.get(f'/api/employees?businessId={biz_id}')
    check(r.status_code in (403, 404), f"B blocked from A's business: {r.status_code}")
    d = j(c2.get('/api/businesses'))
    check(len(d['businesses']) == 1 and d['businesses'][0]['id'] != biz_id, "B sees only own")
    r = c2.get('/alice-cafe/schedule')
    check(r.status_code == 200, "B's own slug alice-cafe works for B")
    r = c2.put(f'/api/employees/{bob_id}', json=dict(roles=[]))
    check(r.status_code in (403, 404), f"B cannot edit A's employee: {r.status_code}")

    print("== employee portal")
    with app.app_context():
        bob_db_id = DBEmployee.query.filter_by(employee_id=bob_id).first().id
    d = j(c.post(f'/api/employees/{bob_id}/invite', json=dict(email=True)))
    print("       invite:", d.get('message') or d.get('error'))
    with app.app_context():
        u = User.query.filter_by(email='bob@test.com').first()
        check(u is not None and u.linked_employee_id == bob_db_id, "employee user account created")
        u.set_password('bobpass123')
        u.must_change_password = False
        db.session.commit()
    c3 = app.test_client()
    d = j(c3.post('/auth/login', json=dict(email='bob@test.com', password='bobpass123')))
    check(d['success'] and d['redirect'] == f'/employee/alice-cafe/{bob_db_id}/schedule', f"employee login redirect {d.get('redirect')}")
    r = c3.get(f'/employee/alice-cafe/{bob_db_id}/schedule')
    check(r.status_code == 200, f"portal page {r.status_code}")
    r = c3.get(f'/employee/alice-cafe/{bob_db_id}/availability')
    check(r.status_code == 200, f"availability page {r.status_code}")
    d = j(c3.get(f'/api/employee/alice-cafe/{bob_db_id}/schedule?weekOffset=0'))
    check(d['success'] and d['published'], f"employee schedule api published={d.get('published')} shifts={len(d.get('schedule', {}).get('employee_shifts', []))}")
    r = c3.get('/alice-cafe/schedule')
    check(r.status_code == 302, f"employee cannot open manager app: {r.status_code}")
    r = c3.get(f'/api/employees?businessId={biz_id}')
    check(r.status_code in (401, 403, 404), f"employee blocked from manager api: {r.status_code}")
    d = j(c3.put(f'/api/employee/{bob_db_id}/availability', json=dict(availability={"0": [[9, 17.5]], "2": [[8, 12]]})))
    check(d['success'], "employee availability save")
    d = j(c3.put(f'/api/employee/{bob_db_id}/preferences', json=dict(notify_sms=False, phone='555-123-4567')))
    check(d['success'] and d['notify_sms'] is False, "employee prefs")
    start = (date.today() + timedelta(days=10)).isoformat()
    d = j(c3.post(f'/api/employee/alice-cafe/{bob_db_id}/pto', json=dict(start_date=start, end_date=start, pto_type='vacation', note='trip')))
    check(d['success'], f"pto create {d}")
    pto_id = d['pto_request']['id']
    d = j(c.get(f'/api/{biz_id}/pto/pending/count'))
    check(d['count'] == 1, "manager sees pending count")
    d = j(c.put(f'/api/{biz_id}/pto/{pto_id}/approve', json=dict(note='enjoy')))
    check(d['success'], f"approve pto {d.get('message')}")
    d = j(c3.get(f'/api/employee/alice-cafe/{bob_db_id}/pto'))
    check(d['pto_requests'][0]['status'] == 'approved', "employee sees approved")

    print("== swap flow")
    carol_id = j(c.post('/api/employees', json=dict(name='Carol', email='carol@test.com', roles=['staff'],
                                                    min_hours=8, max_hours=30, businessId=biz_id)))['employee']['id']
    d = j(c.post('/api/generate', json=dict(businessId=biz_id, weekOffset=1)))
    d = wait_job(c, d['job_id'])
    check(d['status'] == 'done', "week+1 generated")
    check(j(c.post('/api/schedule/publish', json=dict(businessId=biz_id, weekOffset=1)))['success'], "week+1 published")
    ws = d['result']['week_start']
    bob_shifts = [a for a in d['result']['schedule']['assignments'] if a['employee_id'] == bob_id]
    carol_shifts = [a for a in d['result']['schedule']['assignments'] if a['employee_id'] == carol_id]
    print(f"       bob shifts={len(bob_shifts)} carol shifts={len(carol_shifts)}")
    with app.app_context():
        carol_db = DBEmployee.query.filter_by(employee_id=carol_id).first()
        carol_db_id = carol_db.id
        cu, _ = create_or_get_employee_user(carol_db, 'carol@test.com', 'Carol')
        cu.set_password('carolpass1')
        cu.must_change_password = False
        db.session.commit()
    c4 = app.test_client()
    check(j(c4.post('/auth/login', json=dict(email='carol@test.com', password='carolpass1')))['success'], "carol login")
    if bob_shifts:
        s = bob_shifts[0]
        d = j(c3.get(f'/api/employee/alice-cafe/{bob_db_id}/eligible-for-swap?day={s["day"]}&start_hour={s["start_hour"]}'
                     f'&end_hour={s["end_hour"]}&role_id={s["role_id"]}&week_start={ws}'))
        print("       eligible:", [(e['employee_name'], e['eligibility_type']) for e in d['eligible']])
        d = j(c3.post(f'/api/employee/alice-cafe/{bob_db_id}/swap-request',
                      json=dict(day=s['day'], start_hour=s['start_hour'], end_hour=s['end_hour'],
                                role_id=s['role_id'], week_start=ws, note='pls')))
        print("       create swap:", d.get('message'))
        if d.get('success'):
            req_id = d['swap_request']['id']
            d = j(c4.get(f'/api/employee/alice-cafe/{carol_db_id}/swap-requests'))
            check(len(d['incoming']) == 1, f"carol incoming {len(d['incoming'])}")
            d = j(c4.post(f'/api/employee/alice-cafe/{carol_db_id}/swap-request/{req_id}/respond', json=dict(response='accept')))
            check(d['success'], f"carol accept {d.get('message')}")
            d = j(c4.get(f'/api/employee/alice-cafe/{carol_db_id}/schedule?weekStart={ws}'))
            got = any(a['day'] == s['day'] and a['start_hour'] == s['start_hour'] for a in d['schedule']['employee_shifts'])
            check(got, "carol now has bob's shift")
            d = j(c3.get(f'/api/employee/alice-cafe/{bob_db_id}/schedule?weekStart={ws}'))
            lost = not any(a['day'] == s['day'] and a['start_hour'] == s['start_hour'] for a in d['schedule']['employee_shifts'])
            check(lost, "bob no longer has it")
            check(j(c3.post(f'/api/employee/alice-cafe/{bob_db_id}/swap-request/{req_id}/cancel'))['success'] is False, "cannot cancel accepted")

    print("== demo mode (anonymous)")
    c5 = app.test_client()
    r = c5.get('/demo/schedule')
    check(r.status_code == 200 and b'Demo Locations' in r.data, f"demo page {r.status_code}")
    d = j(c5.post('/api/generate', json=dict(businessId='coffee_shop', weekOffset=0)))
    check(d['success'], f"demo generate {d}")
    d = wait_job(c5, d['job_id'])
    check(d['status'] == 'done' and d['result']['success'], f"demo job {d.get('message')} err={d.get('error')}")
    r = c5.get('/alice-cafe/schedule')
    check(r.status_code == 302 and '/auth/login' in r.headers['Location'], "anon manager page -> login")
    r = c5.get(f'/api/employees?businessId={biz_id}')
    check(r.status_code == 401, f"anon api -> 401 ({r.status_code})")
    r = c5.get('/api/admin/migrate-open-for-swaps')
    check(r.status_code == 404, f"admin endpoints gone ({r.status_code})")

    print("== forgot password")
    r = c5.post('/auth/forgot-password', data=dict(email='a@test.com'))
    check(r.status_code == 302, f"forgot -> {r.status_code}")
    with app.app_context():
        tok = PasswordResetToken.query.filter_by(used_at=None).order_by(PasswordResetToken.id.desc()).first()
        check(tok is not None, "token created")
        token = tok.token
    r = c5.get(f'/auth/reset-password/{token}')
    check(r.status_code == 200, f"reset page {r.status_code}")
    r = c5.post(f'/auth/reset-password/{token}', data=dict(password='newpass9999', confirm_password='newpass9999'))
    check(r.status_code == 302, "reset submitted")
    check(j(c5.post('/auth/login', json=dict(email='a@test.com', password='newpass9999')))['success'], "login with new password")
    r = app.test_client().get(f'/auth/reset-password/{token}')
    check(r.status_code == 302, "used token rejected")

    print("== settings page + health")
    r = c.get('/settings')
    check(r.status_code == 200 and b'/alice-cafe/schedule' in r.data, "settings back link is own business")
    check(j(c.get('/api/health'))['status'] == 'ok', "health")
    r = c.get('/app')
    check(r.status_code == 302 and '/alice-cafe/schedule' in r.headers['Location'], "/app -> own business")
    check(c.get('/login').status_code == 302, "/login alias")

    print(f"\nFAILURES: {len(FAILS)}")
    for f in FAILS:
        print("  -", f)
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
