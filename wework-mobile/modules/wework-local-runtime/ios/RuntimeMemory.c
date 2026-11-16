#ifdef WWR_EMBEDDED_ISH
#include <TargetConditionals.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <mach/mach.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <sys/sysctl.h>
#if TARGET_OS_IPHONE
#include <os/proc.h>
#endif
#include "kernel/mm.h"

static dispatch_source_t memory_timer;
static dispatch_source_t pressure_source;
static atomic_bool critical_pressure;

static int sample_memory(void) {
    task_vm_info_data_t info;
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS)
        return -EIO;
    uint64_t footprint = info.phys_footprint;
    if (footprint == 0) return -EIO;
#if TARGET_OS_IPHONE
    uint64_t available = os_proc_available_memory();
    uint64_t limit = footprint + available;
#else
    uint64_t ram = 0;
    size_t size = sizeof(ram);
    if (sysctlbyname("hw.memsize", &ram, &size, NULL, 0) != 0 || ram == 0)
        return -EIO;
    uint64_t limit = ram / 5 * 4;
    uint64_t available = limit > footprint ? limit - footprint : 0;
#endif
    ish_set_memory_status(limit, available, atomic_load(&critical_pressure));
    return 0;
}

int wework_ish_memory_start(void) {
    if (memory_timer != NULL) return sample_memory();
    int err = sample_memory();
    if (err != 0) return err;
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    memory_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    if (memory_timer == NULL) return -ENOMEM;
    pressure_source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
            DISPATCH_MEMORYPRESSURE_NORMAL | DISPATCH_MEMORYPRESSURE_WARN |
            DISPATCH_MEMORYPRESSURE_CRITICAL, queue);
    if (pressure_source == NULL) {
        dispatch_release(memory_timer);
        memory_timer = NULL;
        return -ENOMEM;
    }
    dispatch_source_set_timer(memory_timer, DISPATCH_TIME_NOW,
            250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(memory_timer, ^{
        /* A failed sample leaves the previous timestamp unchanged. Upstream
         * admission fails closed once that sample is older than two seconds. */
        sample_memory();
    });
    dispatch_source_set_event_handler(pressure_source, ^{
        atomic_store(&critical_pressure,
                (dispatch_source_get_data(pressure_source) & DISPATCH_MEMORYPRESSURE_CRITICAL) != 0);
        sample_memory();
    });
    dispatch_resume(memory_timer);
    dispatch_resume(pressure_source);
    return 0;
}
#endif
