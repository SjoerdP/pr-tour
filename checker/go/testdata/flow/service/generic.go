package service

type List[T any] struct {
	items []T
}

func (l *List[T]) Add(v T) {
	l.items = append(l.items, v)
}

func UseGenerics() int {
	var l List[int]
	l.Add(1)
	return Max[int](1, 2)
}

func Paren() {
	(Run)()
}
