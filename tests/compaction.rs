use optchat::{
    Memory, VIEW,
    protocol::{Request, dispatch},
};
use serde_json::json;
use tempfile::tempdir;

#[test]
fn request_local_memory_budget_keeps_every_original_and_does_not_change_the_view() {
    let dir = tempdir().unwrap();
    let mut mem = Memory::open(dir.path(), VIEW).unwrap();
    for i in 0..32 {
        mem.log("user", &format!("original-{i}: {}", "x".repeat(100)), None)
            .unwrap();
    }
    loop {
        let jobs = mem.jobs().unwrap();
        if jobs.is_empty() {
            break;
        }
        for job in jobs {
            mem.submit(
                optchat::store::Key { l: job.l, i: job.i },
                "summary of the covered originals",
            )
            .unwrap();
        }
    }
    let original = mem.render();
    let saved = mem.view().to_vec();
    let request: Request = serde_json::from_value(json!({"op":"view", "max_bytes":256})).unwrap();
    let view = dispatch(&mut mem, request).unwrap()["view"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(view.len() <= 256, "{view}");
    let mut next = 0;
    for line in view
        .lines()
        .skip(1)
        .take_while(|line| !line.starts_with("</chat>"))
    {
        let (range, _) = line.split_once('|').unwrap();
        let (id, n) = range.split_once('+').unwrap();
        assert_eq!(id.parse::<usize>().unwrap(), next);
        next += n.parse::<usize>().unwrap();
    }
    assert_eq!(next, 32);
    assert_eq!(mem.view(), saved);
    assert_eq!(mem.render(), original);
    for i in 0..32 {
        assert!(mem.zoom(i, 1).unwrap().contains(&format!("original-{i}:")));
    }
}
