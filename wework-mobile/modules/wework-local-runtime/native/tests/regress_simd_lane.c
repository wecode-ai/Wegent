#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

typedef void (*lane_probe)(uint8_t *, uint8_t *, const uint8_t *, int64_t *);
#define LANE_CASE(name, opcode, load, count, width, lane, mode, rt, invalid) \
    extern void name(uint8_t *, uint8_t *, const uint8_t *, int64_t *);
#include "regress_simd_lane_cases.inc"
#undef LANE_CASE

struct lane_case {
    const char *name;
    lane_probe run;
    int load, count, width, lane, mode, rt, invalid;
};
static const struct lane_case cases[] = {
#define LANE_CASE(name, opcode, load, count, width, lane, mode, rt, invalid) \
    {#name, name, load, count, width, lane, mode, rt, invalid},
#include "regress_simd_lane_cases.inc"
#undef LANE_CASE
};

static void illegal_instruction(int signal_number) {
    (void)signal_number;
    _exit(77);
}

static int reserved_encoding(const struct lane_case *test, uint8_t *output,
                             uint8_t *memory, const uint8_t *initial) {
    pid_t pid = fork();
    if (pid < 0)
        return 0;
    if (pid == 0) {
        struct sigaction action = {0};
        action.sa_handler = illegal_instruction;
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGILL, &action, NULL) != 0)
            _exit(78);
        int64_t delta = 0;
        test->run(output, memory, initial, &delta);
        _exit(79);
    }
    int status = 0;
    return waitpid(pid, &status, 0) == pid && WIFEXITED(status) &&
           WEXITSTATUS(status) == 77;
}

static int run_case(const struct lane_case *test) {
    uint8_t initial[96], output[96], memory[64];
    uint8_t expected_vectors[96], expected_memory[64];
    for (unsigned i = 0; i < sizeof(initial); i++)
        initial[i] = (uint8_t)(0x31 + i * 7);
    for (unsigned i = 0; i < sizeof(memory); i++)
        memory[i] = (uint8_t)(0xa5 + i * 3);
    memset(output, 0xcc, sizeof(output));
    if (test->invalid)
        return reserved_encoding(test, output, memory + 9, initial);
    memcpy(expected_vectors, initial, sizeof(initial));
    memcpy(expected_memory, memory, sizeof(memory));
    for (int i = 0; i < test->count; i++) {
        int reg = (test->rt + i) % 32;
        int slot = reg >= 30 ? reg - 26 : reg;
        int offset = slot * 16 + test->lane * test->width;
        if (test->load)
            memcpy(expected_vectors + offset, memory + 9 + i * test->width,
                   (size_t)test->width);
        else
            memcpy(expected_memory + 9 + i * test->width, initial + offset,
                   (size_t)test->width);
    }
    int64_t delta = -99;
    test->run(output, memory + 9, initial, &delta);
    int expected_delta = test->mode == 0 ? 0 :
                         test->mode == 1 ? test->count * test->width : 13;
    return delta == expected_delta &&
           memcmp(output, expected_vectors, sizeof(output)) == 0 &&
           memcmp(memory, expected_memory, sizeof(memory)) == 0;
}

int main(void) {
    unsigned failures = 0;
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        int passed = run_case(&cases[i]);
        printf("%s %s\n", passed ? "PASS" : "FAIL", cases[i].name);
        failures += !passed;
    }
    return failures ? 1 : 0;
}
